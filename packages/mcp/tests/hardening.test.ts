import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { HttpError, route, type BasaltRoute, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { z } from 'zod'
import { MCP, mcpPlugin, mcpRoutes, toolSignal, type McpRoutesOptions } from '../src/index.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    user?: { id: string }
  }
}

/** Trusts `x-user-id` and enforces `meta.auth` — a stand-in for authPlugin. */
const identity = definePlugin({
  name: 'test-identity',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const id = request.headers['x-user-id']
      if (typeof id === 'string') context.user = { id }
    }
    const guard: RouteGuard = ({ route: r, context }) => {
      if (r.meta?.['auth'] === true && !context.user) throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required')
    }
    const metadata = ensureMetadata(container)
    metadata.add('http:enrichers', enricher)
    metadata.add('http:guards', guard)
    metadata.add('http:guarded-meta', 'auth')
  },
})

async function boot(routes: BasaltRoute[], routeOptions: McpRoutesOptions = {}, forwardHeaders?: string[]) {
  const app = await createApp({
    plugins: [
      identity,
      mcpPlugin({ routes, ...(forwardHeaders ? { forwardHeaders } : {}) }),
      // Stateless unless a test opts in: these suites predate sessions.
      fastifyPlugin({ routes: [...routes, ...mcpRoutes({ sessions: false, ...routeOptions })] }),
    ],
  }).boot()
  return { app, mcp: app.container.get(MCP), fastify: app.container.get(FASTIFY) }
}

const rpc = (id: number | null, method: string, params?: unknown) => ({
  jsonrpc: '2.0' as const,
  ...(id === null ? {} : { id }),
  method,
  ...(params ? { params } : {}),
})

const created = () => {
  let runs = 0
  const routes = [route({ method: 'POST', url: '/things', meta: { mcp: true }, async handler() { runs++; return { created: true } } })]
  return { routes, runs: () => runs }
}

// FA-034
describe('POST /mcp — Origin and Content-Type', () => {
  it('refuses a foreign Origin with 403 and never runs the tool', async () => {
    const { routes, runs } = created()
    const { app, fastify } = await boot(routes)
    try {
      const r = await fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: { origin: 'https://evil.example', host: 'api.example', 'content-type': 'application/json' },
        payload: rpc(1, 'tools/call', { name: 'post_things', arguments: {} }),
      })
      expect(r.statusCode).toBe(403)
      expect(runs()).toBe(0)
    } finally {
      await app.shutdown()
    }
  })

  it('allows a same-origin browser request and an explicitly allowed origin', async () => {
    const { routes } = created()
    const { app, fastify } = await boot(routes, { allowedOrigins: ['https://agent.example'] })
    try {
      const same = await fastify.inject({ method: 'POST', url: '/mcp', headers: { origin: 'https://api.example', host: 'api.example' }, payload: rpc(1, 'ping') })
      expect(same.statusCode).toBe(200)
      const listed = await fastify.inject({ method: 'POST', url: '/mcp', headers: { origin: 'https://agent.example', host: 'api.example' }, payload: rpc(1, 'ping') })
      expect(listed.statusCode).toBe(200)
      const noOrigin = await fastify.inject({ method: 'POST', url: '/mcp', payload: rpc(1, 'ping') })
      expect(noOrigin.statusCode).toBe(200)
    } finally {
      await app.shutdown()
    }
  })

  it('requires an application/json Content-Type (415 for a CORS-safelisted type)', async () => {
    const { routes, runs } = created()
    const { app, fastify } = await boot(routes)
    try {
      const r = await fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify(rpc(1, 'tools/call', { name: 'post_things', arguments: {} })),
      })
      expect(r.statusCode).toBe(415)
      expect(runs()).toBe(0)
    } finally {
      await app.shutdown()
    }
  })

  it('accepts a JSON-RPC batch', async () => {
    const { routes } = created()
    const { app, fastify } = await boot(routes)
    try {
      const r = await fastify.inject({ method: 'POST', url: '/mcp', payload: [rpc(1, 'ping'), rpc(2, 'tools/list')] })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { id: number }[]).map((m) => m.id).sort()).toEqual([1, 2])
    } finally {
      await app.shutdown()
    }
  })
})

// FA-035
describe('POST /mcp — optional endpoint auth', () => {
  const guarded = [route({ method: 'DELETE', url: '/admin/users/:id', meta: { mcp: true, auth: true }, params: z.object({ id: z.string() }), async handler() { return {} } })]

  it('mcpRoutes({ auth: true }) refuses an anonymous tools/list', async () => {
    const { app, fastify } = await boot(guarded, { auth: true })
    try {
      const anon = await fastify.inject({ method: 'POST', url: '/mcp', payload: rpc(1, 'tools/list') })
      expect(anon.statusCode).toBe(401)
      const authed = await fastify.inject({ method: 'POST', url: '/mcp', headers: { 'x-user-id': 'u1' }, payload: rpc(1, 'tools/list') })
      expect(authed.json().result.tools.map((t: { name: string }) => t.name)).toContain('delete_admin_users_by_id')
    } finally {
      await app.shutdown()
    }
  })
})

// FA-036
describe('synthetic tool request', () => {
  const probe = [
    route({
      method: 'GET',
      url: '/items/:id',
      meta: { mcp: true },
      params: z.object({ id: z.string() }),
      query: z.object({ q: z.string().optional() }),
      async handler({ request }) {
        return {
          ip: request.ip ?? null,
          url: request.url,
          pattern: request.routePattern ?? null,
          cookie: request.headers['cookie'] ?? null,
          rid: request.headers['x-request-id'] ?? null,
          inm: request.headers['if-none-match'] ?? null,
          xff: request.headers['x-forwarded-for'] ?? null,
          custom: request.headers['x-org'] ?? null,
        }
      },
    }),
  ]

  it('forwards only allowlisted headers, carries ip + routePattern and the concrete url', async () => {
    const { app, mcp } = await boot(probe)
    try {
      const r = await mcp.callTool('get_items_by_id', { id: 'a b/5', q: 'x' }, {
        headers: { cookie: 'basalt_session=abc', 'x-request-id': 'attacker-chosen', 'if-none-match': '"etag"', 'x-forwarded-for': '9.9.9.9', 'x-org': 'o1' },
        ip: '10.0.0.7',
      })
      expect(r.structuredContent).toEqual({
        ip: '10.0.0.7',
        url: '/items/a%20b%2F5?q=x',
        pattern: '/items/:id',
        cookie: 'basalt_session=abc',
        rid: null,
        inm: null,
        xff: null,
        custom: null,
      })
    } finally {
      await app.shutdown()
    }
  })

  it('mcpPlugin({ forwardHeaders }) extends the allowlist', async () => {
    const { app, mcp } = await boot(probe, {}, ['x-org'])
    try {
      const r = await mcp.callTool('get_items_by_id', { id: '1' }, { headers: { 'x-org': 'o1' } })
      expect((r.structuredContent as { custom: string }).custom).toBe('o1')
    } finally {
      await app.shutdown()
    }
  })

  it('the /mcp route propagates the client ip into the tool', async () => {
    const { app, fastify } = await boot(probe)
    try {
      const r = await fastify.inject({ method: 'POST', url: '/mcp', remoteAddress: '10.1.2.3', payload: rpc(1, 'tools/call', { name: 'get_items_by_id', arguments: { id: '1' } }) })
      expect(r.json().result.structuredContent.ip).toBe('10.1.2.3')
    } finally {
      await app.shutdown()
    }
  })
})

// FA-037
describe('cancellation reaches route-backed tools', () => {
  it('notifications/cancelled answers the call as cancelled and signals the handler', async () => {
    let completed = 0
    let sawAbort = false
    const routes = [
      route({
        method: 'POST',
        url: '/slow',
        meta: { mcp: true },
        async handler({ request }) {
          await new Promise((r) => setTimeout(r, 150))
          if (toolSignal(request)?.aborted) {
            sawAbort = true
            return { done: false }
          }
          completed++
          return { done: true }
        },
      }),
    ]
    const { app, mcp } = await boot(routes)
    try {
      const session = {}
      const p = mcp.handleMessage(rpc(7, 'tools/call', { name: 'post_slow', arguments: {} }), { session })
      await new Promise((r) => setTimeout(r, 20))
      await mcp.handleMessage(rpc(null, 'notifications/cancelled', { requestId: 7 }), { session })
      const res = (await p) as { result?: { isError?: boolean; structuredContent?: unknown } }
      expect(res.result?.isError).toBe(true)
      expect(res.result?.structuredContent).toBeUndefined()
      await new Promise((r) => setTimeout(r, 200))
      expect(sawAbort).toBe(true)
      expect(completed).toBe(0)
    } finally {
      await app.shutdown()
    }
  })
})

// FA-038
describe('tool result status', () => {
  it('a handler replying 403 comes back as isError', async () => {
    const routes = [route({ method: 'GET', url: '/forbidden', meta: { mcp: true }, async handler({ reply }) { return reply.code(403).send({ error: 'forbidden' }) } })]
    const { app, mcp } = await boot(routes)
    try {
      const r = await mcp.callTool('get_forbidden', {}, {})
      expect(r.isError).toBe(true)
      expect(r.structuredContent).toEqual({ error: 'forbidden' })
    } finally {
      await app.shutdown()
    }
  })
})
