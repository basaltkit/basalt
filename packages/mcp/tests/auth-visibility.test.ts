import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp, definePlugin, ensureMetadata, type BasaltPlugin, type Token } from '@basaltkit/core'
import { route, type BasaltRoute, type RequestEnricher } from '@basaltkit/http'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { honoPlugin, HONO } from '@basaltkit/hono'
import { mcpPlugin, mcpRoutes } from '../src/index.js'

// BK-061: `meta.scopes` (apiKeysPlugin) and `meta.mfa` (authPlugin) filter
// `tools/list` through their side-effect-free visibility checks. `@basaltkit/mcp`
// does not depend on the auth package: loaded from its source by URL so this
// package's typecheck does not pull it in; the slice used here is typed locally.
interface ApiKeysService {
  issue(input: { name: string; scopes?: string[] }): Promise<{ key: string }>
}
const auth = (await import(new URL('../../auth/src/index.ts', import.meta.url).href)) as {
  apiKeysPlugin: (options?: Record<string, unknown>) => BasaltPlugin
  authPlugin: (options: Record<string, unknown>) => BasaltPlugin
  MemoryUserSource: new () => unknown
  API_KEYS: Token<ApiKeysService>
}

type Adapter = 'fastify' | 'express' | 'hono'

/**
 * Stands in for a session: `x-user-id` sets ctx().user and `x-amr` its
 * authentication methods (what authPlugin's enricher copies from a token).
 */
const session = definePlugin({
  name: 'test-session',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const id = request.headers['x-user-id']
      const amr = request.headers['x-amr']
      if (typeof id === 'string') context.user = { id, email: `${id}@example.com` } as never
      if (typeof amr === 'string') (context as Record<string, unknown>)['amr'] = amr.split(',')
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

const routes: BasaltRoute[] = [
  route({ method: 'GET', url: '/open', meta: { mcp: true }, handler: () => ({ ok: true }) }),
  route({ method: 'GET', url: '/reports', meta: { mcp: true, scopes: ['reports:read'] }, handler: () => ({ ok: true }) }),
  route({ method: 'POST', url: '/wire', meta: { mcp: true, auth: true, mfa: true }, handler: () => ({ ok: true }) }),
]

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

async function start(adapter: Adapter) {
  const hooks: string[] = []
  const all = [...routes, ...mcpRoutes({ sessions: false })]
  const http =
    adapter === 'express' ? expressPlugin({ routes: all }) : adapter === 'hono' ? honoPlugin({ routes: all }) : fastifyPlugin({ routes: all })
  const app = await createApp({
    plugins: [
      auth.authPlugin({ users: new auth.MemoryUserSource(), secret: 'test-secret-test-secret-test-secret' }),
      auth.apiKeysPlugin(),
      session,
      mcpPlugin({ routes }),
      http,
    ],
  }).boot()
  app.hooks.onAny((name) => {
    if (String(name).startsWith('auth:')) hooks.push(String(name))
  })

  let port: number
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
  const url = `http://127.0.0.1:${port}/mcp`
  const post = async (message: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(message) })
    return (await res.json()) as any
  }
  const list = async (headers: Record<string, string> = {}) =>
    ((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers)).result.tools as { name: string }[]).map((t) => t.name).sort()
  const keys = app.container.get(auth.API_KEYS)
  return { post, list, keys, hooks }
}

describe.each(['fastify', 'express', 'hono'] as const)('/mcp tools/list hides meta.scopes / meta.mfa tools on %s', (adapter) => {
  it('lists a scoped tool only to a key holding the scope', async () => {
    const { list, keys, hooks } = await start(adapter)
    const { key: narrow } = await keys.issue({ name: 'narrow', scopes: ['other:read'] })
    const { key: reader } = await keys.issue({ name: 'reader', scopes: ['reports:read'] })
    expect(await list()).toEqual(['get_open'])
    expect(await list({ 'x-api-key': narrow })).toEqual(['get_open'])
    expect(await list({ 'x-api-key': reader })).toEqual(['get_open', 'get_reports'])
    // A listing never records a rejection.
    expect(hooks.filter((h) => h === 'auth:apikey_rejected')).toEqual([])
  })

  it('lists an mfa-guarded tool only to a session verified with a second factor', async () => {
    const { list } = await start(adapter)
    expect(await list({ 'x-user-id': 'u1', 'x-amr': 'pwd' })).toEqual(['get_open'])
    expect(await list({ 'x-user-id': 'u1', 'x-amr': 'pwd,mfa' })).toEqual(['get_open', 'post_wire'])
  })

  it('visibility is not authorization: a hidden scoped tool is still refused on call', async () => {
    const { post, keys } = await start(adapter)
    const { key: narrow } = await keys.issue({ name: 'narrow', scopes: ['other:read'] })
    const res = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_reports', arguments: {} } },
      { 'x-api-key': narrow },
    )
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain('SCOPE')
  })
})
