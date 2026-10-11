import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp, ctx, type BasaltApp, type BasaltPlugin } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { honoPlugin, HONO } from '@basaltkit/hono'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { ApiKeys, MemoryApiKeyStore, apiKeysPlugin } from '@basaltkit/auth'
import { mcpPlugin, mcpRoutes } from '../src/index.js'

/**
 * mcpPlugin next to the REAL plugins (tenancy, apiKeysPlugin), not stand-ins,
 * on all three adapters:
 *
 * - a route exposed only through MCP gets the same boot checks an adapter runs
 *   (the `http:meta-validators` bucket, unguarded security meta);
 * - a `/mcp` session opened with a userless API key is bound to that key.
 */

type Adapter = 'fastify' | 'express' | 'hono'
const adapters = ['fastify', 'express', 'hono'] as const

function adapterPlugin(adapter: Adapter, routes: BasaltRoute[]): BasaltPlugin {
  return adapter === 'express' ? expressPlugin({ routes }) : adapter === 'hono' ? honoPlugin({ routes }) : fastifyPlugin({ routes })
}

let current: { close: () => Promise<void> } | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

async function listen(adapter: Adapter, app: BasaltApp): Promise<string> {
  let port: number
  let close: () => Promise<void>
  if (adapter === 'fastify') {
    const fastify = app.container.get(FASTIFY)
    await fastify.listen({ port: 0, host: '127.0.0.1' })
    port = (fastify.server.address() as AddressInfo).port
    close = async () => {
      fastify.server.closeAllConnections()
      await app.shutdown()
    }
  } else {
    const server = await new Promise<Server>((resolve) => {
      if (adapter === 'express') {
        const s: Server = app.container.get(EXPRESS).listen(0, '127.0.0.1', () => resolve(s))
      } else {
        const s = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, () =>
          resolve(s as unknown as Server),
        )
      }
    })
    port = (server.address() as AddressInfo).port
    close = async () => {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      await app.shutdown()
    }
  }
  current = { close }
  return `http://127.0.0.1:${port}/mcp`
}

const tenancy = (required: boolean) =>
  tenancyPlugin({ source: new MemoryTenantSource().add({ id: 'acme', name: 'Acme' }), resolvers: [headerResolver()], required })

describe.each(adapters)('mcpPlugin boot checks on %s', (adapter) => {
  it("refuses the boot for an MCP-only route with meta.tenant: 'none' (tenancy required: true)", async () => {
    // The adapter serves only /mcp; the typo'd route is reachable as a tool only.
    const toolOnly = [route({ method: 'GET', url: '/platform/plans', meta: { mcp: true, tenant: 'none' }, handler: () => ({ plans: [] }) })]
    const boot = createApp({
      plugins: [tenancy(true), mcpPlugin({ routes: toolOnly }), adapterPlugin(adapter, mcpRoutes())],
    }).boot()
    await expect(boot).rejects.toMatchObject({
      code: 'HTTP_INVALID_ROUTE_META',
      problems: [{ route: 'GET /platform/plans', problem: expect.stringContaining('meta.tenant "none" is not valid') }],
    })
  })

  it('refuses an invalid meta.responseHeaders on an MCP-only route', async () => {
    const toolOnly = [
      route({ method: 'GET', url: '/x', meta: { mcp: true, responseHeaders: { 'x-a': 'ok\r\nset-cookie: a=b' } }, handler: () => ({}) }),
    ]
    const boot = createApp({ plugins: [mcpPlugin({ routes: toolOnly }), adapterPlugin(adapter, mcpRoutes())] }).boot()
    await expect(boot).rejects.toMatchObject({ code: 'HTTP_INVALID_ROUTE_META' })
  })

  it('refuses security meta no guard enforces; allowUnguardedMeta waives it like the adapter option', async () => {
    const toolOnly = [route({ method: 'GET', url: '/private', meta: { mcp: true, auth: true }, handler: () => ({}) })]
    await expect(
      createApp({ plugins: [mcpPlugin({ routes: toolOnly }), adapterPlugin(adapter, mcpRoutes())] }).boot(),
    ).rejects.toMatchObject({ code: 'HTTP_UNGUARDED_ROUTE_META' })
    const app = await createApp({
      plugins: [mcpPlugin({ routes: toolOnly, allowUnguardedMeta: ['auth'] }), adapterPlugin(adapter, mcpRoutes())],
    }).boot()
    await app.shutdown()
  })

  it('checks only the routes it exposes: a non-MCP or filtered-out route is the adapter’s business', async () => {
    const routes = [
      route({ method: 'GET', url: '/not-a-tool', meta: { tenant: 'none' }, handler: () => ({}) }),
      route({ method: 'GET', url: '/filtered', meta: { mcp: true, tenant: 'none' }, handler: () => ({}) }),
      route({ method: 'GET', url: '/ok', meta: { mcp: true, tenant: 'never' }, handler: () => ({}) }),
    ]
    const app = await createApp({
      plugins: [tenancy(true), mcpPlugin({ routes, filter: (r) => r.url !== '/filtered' }), adapterPlugin(adapter, mcpRoutes())],
    }).boot()
    await app.shutdown()
  })
})

describe.each(adapters)('/mcp sessions with the real apiKeysPlugin on %s', (adapter) => {
  async function start() {
    const store = new MemoryApiKeyStore()
    const keys = new ApiKeys({ store })
    const tools = [
      route({ method: 'GET', url: '/sync', meta: { mcp: true, scopes: ['sync'] }, handler: () => ({ key: ctx().apiKey?.id ?? null }) }),
    ]
    const app = await createApp({
      plugins: [apiKeysPlugin({ store }), mcpPlugin({ routes: tools }), adapterPlugin(adapter, [...tools, ...mcpRoutes()])],
    }).boot()
    const url = await listen(adapter, app)
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
    return { keys, post, init }
  }
  const callSync = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_sync', arguments: {} } }

  it('binds the session to the verified key: another key, no key, or an unverified key gets 404', async () => {
    const { keys, post, init } = await start()
    const a = await keys.issue({ name: 'a', scopes: ['sync'], serviceId: 'erp-a' })
    const b = await keys.issue({ name: 'b', scopes: ['sync'], serviceId: 'erp-b' })
    const session = await init({ 'x-api-key': a.key })

    const ok = await post(callSync, { 'mcp-session-id': session, 'x-api-key': a.key })
    expect(ok.status).toBe(200)
    expect(ok.body.result.structuredContent).toEqual({ key: a.record.id })

    // Neither request carries an Authorization header: only the key tells them apart.
    expect((await post(callSync, { 'mcp-session-id': session, 'x-api-key': b.key })).status).toBe(404)
    expect((await post(callSync, { 'mcp-session-id': session })).status).toBe(404)
    expect((await post(callSync, { 'mcp-session-id': session, 'x-api-key': 'mk_not_a_real_key' })).status).toBe(404)
  })

  it('the same key over the other carrier (Authorization: Bearer) keeps the session', async () => {
    const { keys, post, init } = await start()
    const a = await keys.issue({ name: 'a', scopes: ['sync'], serviceId: 'erp-a' })
    const session = await init({ 'x-api-key': a.key })
    expect((await post(callSync, { 'mcp-session-id': session, authorization: `Bearer ${a.key}` })).status).toBe(200)
  })

  it('a rotated key keeps its id, so the session survives a rotation', async () => {
    const { keys, post, init } = await start()
    const a = await keys.issue({ name: 'a', scopes: ['sync'], serviceId: 'erp-a' })
    const session = await init({ 'x-api-key': a.key })
    const rotated = await keys.rotate(a.record.id)
    expect((await post(callSync, { 'mcp-session-id': session, 'x-api-key': rotated.key })).status).toBe(200)
  })
})
