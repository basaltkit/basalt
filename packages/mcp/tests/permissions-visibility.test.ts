import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp, definePlugin, ensureMetadata, type BasaltApp, type BasaltPlugin } from '@basaltkit/core'
import { route, type BasaltRoute, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { honoPlugin, HONO } from '@basaltkit/hono'
import { mcpPlugin, mcpRoutes } from '../src/index.js'

// `@basaltkit/mcp` does not depend on the permissions package, and this is the
// only place the two meet — over a real `/mcp`. Loaded from its source by URL
// so this package's typecheck (rootDir `.`) does not pull it into the program;
// the slice used here is typed locally.
interface AccessStore {
  getUserRoles(userId: string, scope: string): Promise<string[]>
  getUserPermissions(userId: string, scope: string): Promise<string[]>
  getRolePermissions(role: string, scope: string): Promise<string[]>
  assignRole(userId: string, role: string, scope: string): Promise<void>
  removeRole(userId: string, role: string, scope: string): Promise<void>
  grantToRole(role: string, permissions: string[], scope: string): Promise<void>
  grantToUser(userId: string, permissions: string[], scope: string): Promise<void>
}
const { MemoryAccessStore, permissionsPlugin } = (await import(
  new URL('../../permissions/src/index.ts', import.meta.url).href
)) as {
  MemoryAccessStore: new () => AccessStore
  permissionsPlugin: (options: { store: AccessStore; superAdmin?: (user: { id: string }) => boolean }) => BasaltPlugin
}

type Adapter = 'fastify' | 'express' | 'hono'

/** Everything a listing must never cause. */
interface Effects {
  guards: number
  hooks: string[]
  writes: string[]
}

/** Trusts `x-user-id` / `Authorization: Bearer <id>` and counts guard runs on tools. */
function identity(effects: Effects): BasaltPlugin {
  return definePlugin({
    name: 'test-identity',
    register({ container, hooks }) {
      const enricher: RequestEnricher = ({ request, context }) => {
        const bearer = request.headers['authorization']
        const id = typeof bearer === 'string' ? bearer.replace(/^Bearer /, '') : request.headers['x-user-id']
        if (typeof id === 'string') context.user = { id }
      }
      const counter: RouteGuard = ({ route: r }) => {
        if (r.meta?.['mcp']) effects.guards++
      }
      hooks.onAny((name) => {
        if (String(name).startsWith('permission:')) effects.hooks.push(String(name))
      })
      const metadata = ensureMetadata(container)
      metadata.add('http:enrichers', enricher)
      metadata.add('http:guards', counter)
    },
  })
}

/** A MemoryAccessStore that records every write reaching it. */
function recordingStore(effects: Effects): AccessStore {
  const store = new MemoryAccessStore()
  return {
    getUserRoles: (u, s) => store.getUserRoles(u, s),
    getUserPermissions: (u, s) => store.getUserPermissions(u, s),
    getRolePermissions: (r, s) => store.getRolePermissions(r, s),
    async assignRole(u, r, s) {
      effects.writes.push(`assignRole:${u}:${r}`)
      await store.assignRole(u, r, s)
    },
    async removeRole(u, r, s) {
      effects.writes.push(`removeRole:${u}:${r}`)
      await store.removeRole(u, r, s)
    },
    async grantToRole(r, p, s) {
      effects.writes.push(`grantToRole:${r}`)
      await store.grantToRole(r, p, s)
    },
    async grantToUser(u, p, s) {
      effects.writes.push(`grantToUser:${u}`)
      await store.grantToUser(u, p, s)
    },
  }
}

const routes: BasaltRoute[] = [
  route({ method: 'GET', url: '/open', meta: { mcp: true }, handler: () => ({ ok: true }) }),
  route({ method: 'GET', url: '/projects', meta: { mcp: true, can: 'projects:read' }, handler: () => ({ ok: true }) }),
  route({ method: 'POST', url: '/projects', meta: { mcp: true, can: ['projects:read', 'projects:create'] }, handler: () => ({ ok: true }) }),
  route({ method: 'DELETE', url: '/projects', meta: { mcp: true, can: 'projects:delete' }, handler: () => ({ ok: true }) }),
  // Unenforceable meta: the guard refuses every call, so the listing hides it.
  route({ method: 'GET', url: '/broken', meta: { mcp: true, can: true as never }, handler: () => ({ ok: true }) }),
]

let current: { app: BasaltApp; close: () => Promise<void> } | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

async function start(adapter: Adapter) {
  const effects: Effects = { guards: 0, hooks: [], writes: [] }
  const store = recordingStore(effects)
  await store.grantToRole('viewer', ['projects:read'], '@global')
  await store.grantToRole('editor', ['projects:*'], '@global')
  await store.assignRole('reader', 'viewer', '@global')
  await store.assignRole('writer', 'viewer', '@global')
  await store.grantToUser('writer', ['projects:create'], '@global')
  await store.assignRole('admin', 'editor', '@global')
  effects.writes.length = 0

  const all = [...routes, ...mcpRoutes({ sessions: false })]
  const http =
    adapter === 'express' ? expressPlugin({ routes: all }) : adapter === 'hono' ? honoPlugin({ routes: all }) : fastifyPlugin({ routes: all })
  const app = await createApp({
    plugins: [
      identity(effects),
      permissionsPlugin({ store, superAdmin: (user) => user.id === 'root' }),
      mcpPlugin({ routes }),
      http,
    ],
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
  const url = `http://127.0.0.1:${port}/mcp`
  const post = async (message: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(message) })
    return { status: res.status, body: (await res.json()) as any }
  }
  const list = async (user?: string) => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, user ? { 'x-user-id': user } : {})
    return (res.body.result.tools as { name: string }[]).map((t) => t.name).sort()
  }
  return { post, list, effects }
}

describe.each(['fastify', 'express', 'hono'] as const)('/mcp tools/list hides meta.can tools on %s', (adapter) => {
  it('lists only the tools whose permissions the caller holds (all-of for arrays)', async () => {
    const { list } = await start(adapter)
    expect(await list()).toEqual(['get_open'])
    expect(await list('nobody')).toEqual(['get_open'])
    expect(await list('reader')).toEqual(['get_open', 'get_projects'])
    expect(await list('writer')).toEqual(['get_open', 'get_projects', 'post_projects'])
    expect(await list('admin')).toEqual(['delete_projects', 'get_open', 'get_projects', 'post_projects'])
    // superAdmin short-circuits like the guard does — but malformed meta stays hidden.
    expect(await list('root')).toEqual(['delete_projects', 'get_open', 'get_projects', 'post_projects'])
  })

  it('has no side effects: no guard run, no permission:* hook (no denial audit), no store write', async () => {
    const { list, effects } = await start(adapter)
    await list()
    await list('nobody')
    await list('reader')
    await list('admin')
    expect(effects).toEqual({ guards: 0, hooks: [], writes: [] })
  })

  it('visibility is not authorization: calling a hidden tool still runs the guard, which denies and audits', async () => {
    const { post, effects } = await start(adapter)
    const call = (id: number, name: string, user: string) =>
      post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }, { authorization: `Bearer ${user}` })
    const denied = await call(1, 'delete_projects', 'reader')
    expect(denied.body.result.isError).toBe(true)
    expect(effects.hooks).toEqual(['permission:denied'])
    const allowed = await call(2, 'get_projects', 'reader')
    expect(allowed.body.result.structuredContent).toEqual({ ok: true })
    expect(effects.guards).toBe(2)
  })
})
