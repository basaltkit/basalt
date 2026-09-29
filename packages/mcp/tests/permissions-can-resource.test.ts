import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { serve } from '@hono/node-server'
import { createApp, definePlugin, ensureMetadata, type BasaltApp, type BasaltPlugin } from '@basaltkit/core'
import { route, type BasaltRoute, type RequestEnricher } from '@basaltkit/http'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { honoPlugin, HONO } from '@basaltkit/hono'
import { MCP, mcpPlugin, mcpRoutes } from '../src/index.js'

// BK-049 / FA-H04 (GAP-2) over the wire: a resource-aware `meta.can` enforces
// the ABAC policy in the guard — identically on every adapter and through MCP
// tool calls — and a `tools/list` never runs its loader. Loaded from source by
// URL (see permissions-visibility.test.ts): this package does not depend on
// permissions, and the slice used here is typed locally.
interface AccessStore {
  grantToUser(userId: string, permissions: string[], scope: string): Promise<void>
}
interface Policy {
  resource: string
}
interface LoaderInput {
  params: { id: string }
}
const permissionsModule = (await import(new URL('../../permissions/src/index.ts', import.meta.url).href)) as {
  MemoryAccessStore: new () => AccessStore
  definePolicy: <T>(resource: string, checks: Record<string, (user: { id: string }, resource: T) => boolean>) => Policy
  canResource: <T>(permission?: string) => T
  permissionsPlugin: (options: { store: AccessStore; policies?: Policy[] }) => BasaltPlugin
}
const { MemoryAccessStore, definePolicy, canResource, permissionsPlugin } = permissionsModule

type Adapter = 'fastify' | 'express' | 'hono'

interface Project {
  id: string
  ownerId: string
}
const projects = new Map<string, Project>([
  ['p-alice', { id: 'p-alice', ownerId: 'alice' }],
  ['p-bob', { id: 'p-bob', ownerId: 'bob' }],
])

/** Trusts `x-user-id` (tests only) so a REST request and a tool call carry an identity. */
const identity: BasaltPlugin = definePlugin({
  name: 'test-identity-can-resource',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const id = request.headers['x-user-id']
      if (typeof id === 'string') context.user = { id }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

function makeRoutes(loads: string[]): BasaltRoute[] {
  const load = async ({ params }: LoaderInput) => {
    loads.push(params.id)
    return projects.get(params.id) ?? null
  }
  return [
    route({
      method: 'PATCH',
      url: '/projects/:id',
      params: z.object({ id: z.string() }),
      body: z.object({ name: z.string() }),
      meta: { mcp: true, can: { permission: 'projects:update', resource: load } } as never,
      handler: ({ body }) => ({ renamed: body.name, owner: canResource<Project>().ownerId }),
    }),
    // GAP-2d: an unenforceable declaration is refused on every call, never skipped.
    route({ method: 'GET', url: '/bad', meta: { mcp: true, can: true as never }, handler: () => ({ leaked: true }) }),
  ]
}

let current: { app: BasaltApp; close: () => Promise<void> } | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

async function start(adapter: Adapter) {
  const loads: string[] = []
  const routes = makeRoutes(loads)
  const store = new MemoryAccessStore()
  await store.grantToUser('alice', ['projects:*'], '@global')
  const OwnerPolicy = definePolicy<Project>('projects', { update: (user, project) => project.ownerId === user.id })

  const all = [...routes, ...mcpRoutes({ sessions: false })]
  const http =
    adapter === 'express' ? expressPlugin({ routes: all }) : adapter === 'hono' ? honoPlugin({ routes: all }) : fastifyPlugin({ routes: all })
  const app = await createApp({
    plugins: [identity, permissionsPlugin({ store, policies: [OwnerPolicy] }), mcpPlugin({ routes, forwardHeaders: ['x-user-id'] }), http],
  }).boot()

  let port: number
  let close: () => Promise<void>
  if (adapter === 'express') {
    const server: Server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    port = (server.address() as AddressInfo).port
    close = async () => {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      await app.shutdown()
    }
  } else if (adapter === 'hono') {
    const { server, port: p } = await new Promise<{ server: Server; port: number }>((resolve) => {
      const s = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
        resolve({ server: s as unknown as Server, port: info.port }),
      )
    })
    port = p
    close = async () => {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      await app.shutdown()
    }
  } else {
    const fastify = app.container.get(FASTIFY)
    await fastify.listen({ port: 0, host: '127.0.0.1' })
    port = (fastify.server.address() as AddressInfo).port
    close = async () => {
      fastify.server.closeAllConnections()
      await app.shutdown()
    }
  }
  current = { app, close }
  const base = `http://127.0.0.1:${port}`
  const headers = (user?: string): Record<string, string> => ({
    'content-type': 'application/json',
    ...(user ? { 'x-user-id': user } : {}),
  })
  const rest = async (id: string, user?: string) => {
    const res = await fetch(`${base}/projects/${id}`, { method: 'PATCH', headers: headers(user), body: JSON.stringify({ name: 'renamed' }) })
    return { status: res.status, body: (await res.json()) as any }
  }
  const rpc = async (message: unknown, user?: string) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: headers(user), body: JSON.stringify(message) })
    return (await res.json()) as any
  }
  const call = async (name: string, args: Record<string, unknown>, user?: string) =>
    (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, user)).result as {
      isError?: boolean
      structuredContent?: unknown
      content: { text: string }[]
    }
  const list = async (user?: string) =>
    ((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, user)).result.tools as { name: string }[]).map((t) => t.name).sort()
  return { app, loads, rest, call, list }
}

describe.each(['fastify', 'express', 'hono'] as const)('resource-aware meta.can on %s (REST and /mcp)', (adapter) => {
  it('owner allowed, handler gets the guard-loaded resource (loaded once)', async () => {
    const { rest, call, loads } = await start(adapter)
    expect(await rest('p-alice', 'alice')).toEqual({ status: 200, body: { renamed: 'renamed', owner: 'alice' } })
    // bob owns p-bob and holds no grant at all: the policy alone decides.
    expect((await rest('p-bob', 'bob')).status).toBe(200)
    const viaTool = await call('patch_projects_by_id', { id: 'p-alice', name: 'x' }, 'alice')
    expect(viaTool.isError).toBeFalsy()
    expect(viaTool.structuredContent).toEqual({ renamed: 'x', owner: 'alice' })
    expect(loads).toEqual(['p-alice', 'p-bob', 'p-alice'])
  })

  it('GAP-2a: non-owner with a broad grant (projects:*) is refused 403 — over REST and as a tool call', async () => {
    const { rest, call } = await start(adapter)
    const denied = await rest('p-bob', 'alice')
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('PERMISSION_DENIED')
    const viaTool = await call('patch_projects_by_id', { id: 'p-bob', name: 'x' }, 'alice')
    expect(viaTool.isError).toBe(true)
    expect(viaTool.content[0]!.text).toContain('PERMISSION_DENIED')
    expect(viaTool.content[0]!.text).not.toContain('AUTH_REQUIRED')
  })

  it('missing resource → 404 RESOURCE_NOT_FOUND; anonymous → 401 before any load', async () => {
    const { rest, call, loads } = await start(adapter)
    const anonymous = await rest('p-alice')
    expect(anonymous.status).toBe(401)
    expect((await call('patch_projects_by_id', { id: 'p-alice', name: 'x' })).content[0]!.text).toMatch(/AUTH_REQUIRED/)
    expect(loads).toEqual([])
    const missing = await rest('nope', 'alice')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('RESOURCE_NOT_FOUND')
    const viaTool = await call('patch_projects_by_id', { id: 'nope', name: 'x' }, 'alice')
    expect(viaTool.isError).toBe(true)
    expect(viaTool.content[0]!.text).toContain('RESOURCE_NOT_FOUND')
  })

  it('tools/list never calls the loader; lists the requirement tool to any authenticated caller, hides malformed meta', async () => {
    const { list, loads } = await start(adapter)
    expect(await list()).toEqual([])
    expect(await list('alice')).toEqual(['patch_projects_by_id'])
    expect(await list('stranger')).toEqual(['patch_projects_by_id'])
    expect(loads).toEqual([])
  })

  it('GAP-2d: malformed meta.can is refused on the call, not skipped', async () => {
    const { call } = await start(adapter)
    const r = await call('get_bad', {}, 'alice')
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).not.toContain('leaked')
  })
})

describe('resource-aware meta.can through the in-process MCP client (mcp.callTool)', () => {
  it('GAP-2a–c: policy enforced by the guard, owner passes, no identity fails closed', async () => {
    const { app, loads } = await start('fastify')
    const mcp = app.container.get(MCP)
    const call = (args: Record<string, unknown>, user?: string) =>
      mcp.callTool('patch_projects_by_id', args, { headers: user ? { 'x-user-id': user } : {} } as never)
    const denied = await call({ id: 'p-bob', name: 'x' }, 'alice')
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('PERMISSION_DENIED')
    const allowed = await call({ id: 'p-alice', name: 'x' }, 'alice')
    expect(allowed.structuredContent).toEqual({ renamed: 'x', owner: 'alice' })
    const anonymous = await call({ id: 'p-alice', name: 'x' })
    expect(anonymous.isError).toBe(true)
    expect(JSON.stringify(anonymous.content)).toMatch(/AUTH_REQUIRED/)
    expect(loads).toEqual(['p-bob', 'p-alice'])
  })
})
