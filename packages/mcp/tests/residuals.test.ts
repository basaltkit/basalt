import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp, definePlugin, ensureMetadata, type BasaltApp, type BasaltPlugin } from '@basaltkit/core'
import {
  HttpError,
  route,
  type BasaltRoute,
  type RequestEnricher,
  type RouteGuard,
  type RouteVisibilityCheck,
} from '@basaltkit/http'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { honoPlugin, HONO } from '@basaltkit/hono'
import { HttpClientTransport, McpClient, mcpPlugin, mcpRoutes, toolSignal, type McpRoutesOptions } from '../src/index.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    user?: { id: string }
  }
}

type Adapter = 'fastify' | 'express' | 'hono'

/**
 * Trusts `x-user-id` and enforces `meta.auth` (a stand-in for authPlugin) and
 * `meta.clearance` (a stand-in for a plugin with a pure visibility check).
 * Every guard run is counted — a listing must never run one.
 */
function identity(counter: { guards: number; visibility: number }): BasaltPlugin {
  return definePlugin({
    name: 'test-identity',
    register({ container }) {
      const enricher: RequestEnricher = ({ request, context }) => {
        // `authorization` is what a tool call inherits (x-user-id is not forwarded).
        const bearer = request.headers['authorization']
        const id = typeof bearer === 'string' ? bearer.replace(/^Bearer /, '') : request.headers['x-user-id']
        if (typeof id === 'string') context.user = { id }
      }
      const guard: RouteGuard = ({ route: r, context }) => {
        if (r.meta?.['mcp']) counter.guards++
        if (r.meta?.['auth'] === true && !context.user) throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required')
        if (r.meta?.['clearance'] === 'top' && context.user?.id !== 'boss') throw new HttpError(403, 'FORBIDDEN', 'No')
      }
      const visibility: RouteVisibilityCheck = ({ route: r, context }) => {
        counter.visibility++
        if (r.meta?.['clearance'] === 'top') return (context['user'] as { id?: string } | undefined)?.id === 'boss'
        return undefined
      }
      const metadata = ensureMetadata(container)
      metadata.add('http:enrichers', enricher)
      metadata.add('http:guards', guard)
      metadata.add('http:guarded-meta', 'auth')
      metadata.add('http:route-visibility', visibility)
    },
  })
}

/** A tool that holds until released or its call is cancelled. */
function holdRoutes() {
  const releases: (() => void)[] = []
  const outcomes: string[] = []
  let started = 0
  const routes: BasaltRoute[] = [
    route({
      method: 'POST',
      url: '/hold',
      meta: { mcp: true },
      async handler({ request }) {
        started++
        const outcome = await new Promise<string>((resolve) => {
          releases.push(() => resolve('released'))
          toolSignal(request)?.addEventListener('abort', () => resolve('aborted'))
        })
        outcomes.push(outcome)
        return { outcome }
      },
    }),
    route({ method: 'GET', url: '/public', meta: { mcp: true }, handler: () => ({ ok: true }) }),
    route({ method: 'GET', url: '/private', meta: { mcp: true, auth: true }, handler: () => ({ ok: true }) }),
    route({ method: 'GET', url: '/secret', meta: { mcp: true, auth: true, clearance: 'top' }, handler: () => ({ ok: true }) }),
  ]
  return { routes, releases, outcomes, started: () => started }
}

let current: { app: BasaltApp; close: () => Promise<void> } | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

async function start(adapter: Adapter, routes: BasaltRoute[], options: McpRoutesOptions, counter = { guards: 0, visibility: 0 }) {
  const all = [...routes, ...mcpRoutes(options)]
  const plugin =
    adapter === 'express' ? expressPlugin({ routes: all }) : adapter === 'hono' ? honoPlugin({ routes: all }) : fastifyPlugin({ routes: all })
  const app = await createApp({ plugins: [identity(counter), mcpPlugin({ routes }), plugin] }).boot()
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
  const url = `http://127.0.0.1:${port}/mcp`
  const post = async (message: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(message) })
    const text = await res.text()
    return { status: res.status, session: res.headers.get('mcp-session-id') ?? undefined, body: text ? JSON.parse(text) : null }
  }
  const init = async (headers: Record<string, string> = {}) => {
    const res = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, headers)
    expect(res.status).toBe(200)
    return res.session as string
  }
  return { url, post, init, counter }
}

const call = (id: number, name = 'post_hold') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
const cancel = (requestId: number) => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } })
const list = (id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/list' })
const names = (res: { body: { result: { tools: { name: string }[] } } }) => res.body.result.tools.map((t) => t.name).sort()
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe.each(['fastify', 'express', 'hono'] as const)('/mcp sessions on %s (FA-037 residual)', (adapter) => {
  it('a notifications/cancelled in a later POST of the same session cancels the call', async () => {
    const hold = holdRoutes()
    const { post, init } = await start(adapter, hold.routes, {})
    const session = await init()
    const pending = post(call(7), { 'mcp-session-id': session })
    await waitFor(() => hold.started() === 1)
    expect((await post(cancel(7), { 'mcp-session-id': session })).status).toBe(202)
    const result = await pending
    expect(result.body.result.isError).toBe(true)
    expect(result.body.result.content[0].text).toContain('CANCELLED')
    await waitFor(() => hold.outcomes.length === 1)
    expect(hold.outcomes).toEqual(['aborted'])
  })

  it('another session can never cancel it', async () => {
    const hold = holdRoutes()
    const { post, init } = await start(adapter, hold.routes, {})
    const mine = await init()
    const theirs = await init()
    const pending = post(call(7), { 'mcp-session-id': mine })
    await waitFor(() => hold.started() === 1)
    expect((await post(cancel(7), { 'mcp-session-id': theirs })).status).toBe(202)
    hold.releases[0]!()
    expect((await pending).body.result.structuredContent).toEqual({ outcome: 'released' })
  })

  it('requires the session header (400), refuses unknown or foreign sessions (404), DELETE ends one', async () => {
    const { url, post, init } = await start(adapter, holdRoutes().routes, {})
    const alice = await init({ 'x-user-id': 'alice' })
    expect((await post(list())).status).toBe(400)
    expect((await post(list(), { 'mcp-session-id': 'forged' })).status).toBe(404)
    expect((await post(list(), { 'mcp-session-id': alice, 'x-user-id': 'alice' })).status).toBe(200)
    // Bound to the principal that opened it: another user, or anonymous, gets 404.
    expect((await post(list(), { 'mcp-session-id': alice, 'x-user-id': 'mallory' })).status).toBe(404)
    expect((await post(list(), { 'mcp-session-id': alice })).status).toBe(404)
    expect((await post(cancel(1), { 'mcp-session-id': alice, 'x-user-id': 'mallory' })).status).toBe(404)
    const del = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': alice, 'x-user-id': 'alice' } })
    expect(del.status).toBe(204)
    expect((await post(list(), { 'mcp-session-id': alice, 'x-user-id': 'alice' })).status).toBe(404)
  })

  it('sessions: false stays stateless (no header issued nor required)', async () => {
    const { post } = await start(adapter, holdRoutes().routes, { sessions: false })
    const opened = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })
    expect(opened.session).toBeUndefined()
    expect((await post(list())).status).toBe(200)
  })

  it('McpClient over HttpClientTransport carries the session and ends it on close', async () => {
    const { url, post } = await start(adapter, holdRoutes().routes, {})
    const transport = new HttpClientTransport(url)
    const client = new McpClient(transport)
    await client.connect()
    const session = transport.sessionId
    expect(session).toBeDefined()
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await client.close()
    expect(transport.sessionId).toBeUndefined()
    expect((await post(list(), { 'mcp-session-id': session! })).status).toBe(404)
  })
})

describe.each(['fastify', 'express', 'hono'] as const)('/mcp tools/list visibility on %s (FA-035 residual)', (adapter) => {
  it('hides meta.auth tools from anonymous callers and runs no guard to decide', async () => {
    const counter = { guards: 0, visibility: 0 }
    const { post } = await start(adapter, holdRoutes().routes, { sessions: false }, counter)
    const anon = await post(list())
    expect(names(anon)).toEqual(['get_public', 'post_hold'])
    expect(counter.guards).toBe(0) // pure checks only: no rate limit, no audit, no denial
    expect(counter.visibility).toBeGreaterThan(0)

    const user = await post(list(), { 'x-user-id': 'u1' })
    expect(names(user)).toEqual(['get_private', 'get_public', 'post_hold'])
    const boss = await post(list(), { 'x-user-id': 'boss' })
    expect(names(boss)).toEqual(['get_private', 'get_public', 'get_secret', 'post_hold'])
    expect(counter.guards).toBe(0)
  })

  it('visibility is not authorization: a hidden tool can still be called and its guards decide', async () => {
    const { post } = await start(adapter, holdRoutes().routes, { sessions: false })
    const denied = await post(call(1, 'get_secret'), { authorization: 'Bearer u1' })
    expect(denied.body.result.isError).toBe(true)
    const allowed = await post(call(2, 'get_secret'), { authorization: 'Bearer boss' })
    expect(allowed.body.result.structuredContent).toEqual({ ok: true })
  })

  it('listVisibleOnly: false lists every tool', async () => {
    const { post } = await start(adapter, holdRoutes().routes, { sessions: false, listVisibleOnly: false })
    expect(names(await post(list()))).toEqual(['get_private', 'get_public', 'get_secret', 'post_hold'])
  })
})
