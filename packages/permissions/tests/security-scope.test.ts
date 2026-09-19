import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, HookBus, runWithContext } from '@basaltkit/core'
import { route, type RequestEnricher } from '@basaltkit/http'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import {
  Gate,
  GLOBAL_SCOPE,
  LEGACY_GLOBAL_SCOPE,
  MemoryAccessStore,
  ReservedScopeError,
  permissionsPlugin,
} from '../src/index.js'

/**
 * F07 · The global scope must not be reachable by naming a tenant after it.
 *
 * Grants are keyed by scope, and the scope of a request is its tenant id. The
 * global scope used to be the plain string 'global', so a tenant whose id was
 * 'global' wrote its members' roles (teams mirrors every membership into the
 * AccessStore under the tenant id) straight into the platform-wide bucket.
 */
describe('F07 · GLOBAL_SCOPE cannot collide with a tenant id', () => {
  it('a role held in a tenant named "global" grants nothing in other tenants or centrally', async () => {
    const store = new MemoryAccessStore()
    // What `Teams.addMember('global', 'mallory', 'owner')` mirrors.
    await store.assignRole('mallory', 'owner', 'global')
    await store.grantToRole('owner', ['*'], 'global')
    const gate = new Gate({ store })

    const inAcme = await runWithContext({ tenant: { id: 'acme' } }, () => gate.can({ id: 'mallory' }, 'billing:refund'))
    const central = await runWithContext({}, () => gate.can({ id: 'mallory' }, 'billing:refund'))
    expect(inAcme).toBe(false)
    expect(central).toBe(false)
    expect(await runWithContext({ tenant: { id: 'acme' } }, () => gate.hasRole({ id: 'mallory' }, 'owner'))).toBe(false)
  })

  it('GLOBAL_SCOPE is not a value a slug, hostname label or uuid can take', () => {
    expect(GLOBAL_SCOPE).not.toBe('global')
    expect(GLOBAL_SCOPE).not.toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('still honours genuine global grants in every tenant and centrally', async () => {
    const store = new MemoryAccessStore()
    await store.assignRole('ada', 'admin', GLOBAL_SCOPE)
    await store.grantToRole('admin', ['projects:*'], GLOBAL_SCOPE)
    const gate = new Gate({ store })
    expect(await runWithContext({ tenant: { id: 'acme' } }, () => gate.can({ id: 'ada' }, 'projects:delete'))).toBe(true)
    expect(await runWithContext({}, () => gate.can({ id: 'ada' }, 'projects:delete'))).toBe(true)
  })

  it('refuses to run a check in a tenant whose id is a reserved scope', async () => {
    const store = new MemoryAccessStore()
    const gate = new Gate({ store })
    for (const id of [GLOBAL_SCOPE, LEGACY_GLOBAL_SCOPE]) {
      await expect(runWithContext({ tenant: { id } }, () => gate.can({ id: 'u' }, 'x:y'))).rejects.toBeInstanceOf(
        ReservedScopeError,
      )
    }
  })

  it('a tenant context without a usable id fails closed instead of falling back to GLOBAL_SCOPE', async () => {
    // `tenant?.id ?? GLOBAL_SCOPE` sent a request that IS inside a tenant, but
    // whose tenant object carries no string id, to the global bucket — where
    // `gate.assignRole()` with its default scope then wrote platform-wide grants.
    const store = new MemoryAccessStore()
    const gate = new Gate({ store })
    for (const tenant of [{}, { id: null }, { id: '' }, { id: 42 }, { id: ['acme'] }, 'acme']) {
      await expect(runWithContext({ tenant } as never, () => gate.assignRole('mallory', 'owner'))).rejects.toBeInstanceOf(
        ReservedScopeError,
      )
    }
    expect(await store.getUserRoles('mallory', GLOBAL_SCOPE)).toEqual([])
    // No tenant at all (or an explicit null) is still the central scope.
    expect(await runWithContext({}, () => gate.can({ id: 'u' }, 'x:y'))).toBe(false)
    expect(await runWithContext({ tenant: null } as never, () => gate.can({ id: 'u' }, 'x:y'))).toBe(false)
  })

  it('reads legacy "global" rows only with the explicit readLegacyGlobalScope option', async () => {
    const store = new MemoryAccessStore()
    await store.grantToUser('ada', ['projects:*'], LEGACY_GLOBAL_SCOPE)
    const strict = new Gate({ store })
    const legacy = new Gate({ store, readLegacyGlobalScope: true })
    const check = (gate: Gate) => runWithContext({ tenant: { id: 'acme' } }, () => gate.can({ id: 'ada' }, 'projects:read'))
    expect(await check(strict)).toBe(false)
    expect(await check(legacy)).toBe(true)
  })

  it('MemoryAccessStore keys cannot be forged by ids containing the separator', async () => {
    const store = new MemoryAccessStore()
    await store.assignRole('c', 'admin', 'a::b')
    // `${scope}::${id}` made ('a::b', 'c') and ('a', 'b::c') the same key.
    expect(await store.getUserRoles('b::c', 'a')).toEqual([])
    expect(await store.getUserRoles('c', 'a::b')).toEqual(['admin'])
  })
})

/** Test-only authentication: trusts x-user-id / x-tenant-id headers. */
const fakeAuth = definePlugin({
  name: 'fake-auth',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const userId = request.headers['x-user-id']
      const tenantId = request.headers['x-tenant-id']
      if (typeof userId === 'string') context.user = { id: userId }
      if (typeof tenantId === 'string') (context as Record<string, unknown>).tenant = { id: tenantId }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

/**
 * F44 · Audience confinement must see the same roles `can()` sees.
 *
 * `can()` consults the current scope AND the global scope, but the audience
 * guard only looked at the current scope. A confined role assigned globally
 * therefore vanished inside any tenant, and the caller became "unconfined".
 */
describe('F44 · audiences include roles held in GLOBAL_SCOPE', () => {
  async function boot() {
    const store = new MemoryAccessStore()
    await store.grantToRole('client', ['matter:read'], GLOBAL_SCOPE)
    await store.assignRole('a-client', 'client', GLOBAL_SCOPE)
    await store.assignRole('staff', 'lawyer', 'acme')
    await store.assignRole('staff', 'client', GLOBAL_SCOPE)
    const app = await createApp({
      plugins: [
        fakeAuth,
        permissionsPlugin({ store, audiences: { portal: { roles: ['client'], allow: ['portal'] } } }),
        fastifyPlugin({
          routes: [
            route({ method: 'GET', url: '/matters', meta: { can: 'matter:read' }, handler: () => ({ internal: true }) }),
            route({ method: 'GET', url: '/open', handler: () => ({ open: true }) }),
          ],
        }),
      ],
    }).boot()
    return { app, server: app.container.get(FASTIFY) }
  }

  it('confines a globally-assigned client inside a tenant exactly as outside one', async () => {
    const { app, server } = await boot()
    const noTenant = await server.inject({ method: 'GET', url: '/matters', headers: { 'x-user-id': 'a-client' } })
    const inTenant = await server.inject({
      method: 'GET',
      url: '/matters',
      headers: { 'x-user-id': 'a-client', 'x-tenant-id': 'acme' },
    })
    const noCan = await server.inject({
      method: 'GET',
      url: '/open',
      headers: { 'x-user-id': 'a-client', 'x-tenant-id': 'acme' },
    })
    expect(noTenant.statusCode).toBe(403)
    expect(inTenant.statusCode).toBe(403)
    expect(noCan.statusCode).toBe(403)
    await app.shutdown()
  })

  it('an unconfined tenant role plus a global confined role stays unconfined (union semantics)', async () => {
    const { app, server } = await boot()
    const r = await server.inject({ method: 'GET', url: '/open', headers: { 'x-user-id': 'staff', 'x-tenant-id': 'acme' } })
    expect(r.statusCode).toBe(200)
    await app.shutdown()
  })

  it('an unnamed GLOBAL baseline role does not un-confine a client inside their tenant', async () => {
    // Every signup holds a global 'user' role (e.g. to create workspaces). Counting
    // it alongside the tenant's roles made the tenant's portal client "unconfined"
    // there, so it reached internal routes that only rely on the audience guard.
    const store = new MemoryAccessStore()
    await store.grantToRole('user', ['workspaces:create'], GLOBAL_SCOPE)
    await store.assignRole('cli', 'user', GLOBAL_SCOPE)
    await store.assignRole('cli', 'client', 'acme')
    const app = await createApp({
      plugins: [
        fakeAuth,
        permissionsPlugin({ store, audiences: { portal: { roles: ['client'], allow: ['portal'] } } }),
        fastifyPlugin({
          routes: [
            route({ method: 'GET', url: '/internal', handler: () => ({ internal: true }) }),
            route({ method: 'GET', url: '/portal', meta: { audience: 'portal' }, handler: () => ({ portal: true }) }),
          ],
        }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)
    const headers = { 'x-user-id': 'cli', 'x-tenant-id': 'acme' }
    expect((await server.inject({ method: 'GET', url: '/internal', headers })).statusCode).toBe(403)
    expect((await server.inject({ method: 'GET', url: '/portal', headers })).statusCode).toBe(200)
    // Outside the tenant only the global role applies, and it names no audience.
    expect((await server.inject({ method: 'GET', url: '/internal', headers: { 'x-user-id': 'cli' } })).statusCode).toBe(200)
    await app.shutdown()
  })
})

/**
 * F55b · Denials and privilege changes must reach the audit trail.
 *
 * `auditPlugin` listens for `permission:**` by default, but nothing emitted it.
 */
describe('F55b · permission hooks', () => {
  it('Gate emits permission:denied on authorize() and on each grant/role change', async () => {
    const hooks = new HookBus()
    const seen: Array<[string, unknown]> = []
    hooks.onAny((hook, payload) => {
      seen.push([hook, payload])
    })
    const gate = new Gate({ store: new MemoryAccessStore(), hooks })

    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      await expect(gate.authorize({ id: 'u1' }, 'invoices:delete')).rejects.toThrow()
      await gate.assignRole('u1', 'editor')
      await gate.grantToRole('editor', ['invoices:read'])
      await gate.grantToUser('u1', ['invoices:export'])
      await gate.removeRole('u1', 'editor')
    })

    expect(seen.map(([h]) => h)).toEqual([
      'permission:denied',
      'permission:role_assigned',
      'permission:granted',
      'permission:granted',
      'permission:role_removed',
    ])
    expect(seen[0]![1]).toEqual({ userId: 'u1', permission: 'invoices:delete', scope: 'acme' })
    expect(seen[1]![1]).toEqual({ userId: 'u1', role: 'editor', scope: 'acme' })
    expect(seen[2]![1]).toEqual({ role: 'editor', permissions: ['invoices:read'], scope: 'acme' })
    expect(seen[3]![1]).toEqual({ userId: 'u1', permissions: ['invoices:export'], scope: 'acme' })
  })

  it('permissionsPlugin wires the app hooks: a meta.can denial is emitted', async () => {
    const store = new MemoryAccessStore()
    const app = await createApp({
      plugins: [
        fakeAuth,
        permissionsPlugin({ store }),
        fastifyPlugin({
          routes: [route({ method: 'GET', url: '/x', meta: { can: 'x:read' }, handler: () => ({ ok: true }) })],
        }),
      ],
    }).boot()
    const seen: string[] = []
    app.hooks.onAny((hook) => {
      seen.push(hook)
    })
    const r = await app.container
      .get(FASTIFY)
      .inject({ method: 'GET', url: '/x', headers: { 'x-user-id': 'u1', 'x-tenant-id': 'acme' } })
    expect(r.statusCode).toBe(403)
    expect(seen).toContain('permission:denied')
    await app.shutdown()
  })

  it('an explicit `hooks: undefined` in the options does not unhook the app bus', async () => {
    // Options assembled from config (`{ ...config, hooks: config.hooks }`) must
    // not silently switch the audit trail off.
    const app = await createApp({
      plugins: [
        fakeAuth,
        // Plain JS (or a cast) can pass it even though the type forbids it.
        permissionsPlugin({ store: new MemoryAccessStore(), hooks: undefined } as never),
        fastifyPlugin({
          routes: [route({ method: 'GET', url: '/x', meta: { can: 'x:read' }, handler: () => ({ ok: true }) })],
        }),
      ],
    }).boot()
    const seen: string[] = []
    app.hooks.onAny((hook) => {
      seen.push(hook)
    })
    const r = await app.container.get(FASTIFY).inject({ method: 'GET', url: '/x', headers: { 'x-user-id': 'u1' } })
    expect(r.statusCode).toBe(403)
    expect(seen).toContain('permission:denied')
    await app.shutdown()
  })
})
