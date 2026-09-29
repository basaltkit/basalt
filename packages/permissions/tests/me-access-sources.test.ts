import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import {
  GATE,
  GLOBAL_SCOPE,
  Gate,
  MemoryAccessStore,
  MemoryDelegationStore,
  MemoryTemporaryGrantStore,
  accessRoutes,
  permissionsPlugin,
  permitted,
  type AccessReport,
} from '../src/index.js'

/**
 * `GET /me/access` exists so a menu shows the doors that open. It used to read
 * the current tenant's standing grants only — a global grant, a temporary
 * grant or a delegation opened the door on the server while the menu hid it.
 * And `hasRole()` answered `true` for any role to a super admin, which is not
 * membership: it is the bypass leaking into a question about roles.
 */

async function setup(extra: { superAdmin?: (user: { id: string; [k: string]: unknown }) => boolean } = {}) {
  let t = 1_000
  const store = new MemoryAccessStore()
  const temporaryGrants = new MemoryTemporaryGrantStore()
  const delegations = new MemoryDelegationStore()
  const app = await createApp({
    plugins: [permissionsPlugin({ store, temporaryGrants, delegations, now: () => t, ...extra })],
  }).boot()
  const gate = app.container.get(GATE)
  const [route] = accessRoutes()
  const ask = (user: { id: string; [k: string]: unknown }, tenant = 'acme') =>
    runWithContext({ user, tenant: { id: tenant }, container: app.container }, () =>
      (route!.handler as (a: unknown) => Promise<AccessReport>)({}),
    )
  const can = (user: { id: string }, permission: string, tenant = 'acme') =>
    runWithContext({ tenant: { id: tenant }, container: app.container }, () => gate.can(user, permission))
  return { app, gate, store, ask, can, setNow: (n: number) => (t = n) }
}

describe('Melhorias 3 · GET /me/access reports every source a check honours', () => {
  it('includes @global grants inside a tenant (direct and via a global role)', async () => {
    const { app, gate, ask, can } = await setup()
    await gate.grantToUser('u1', ['billing:read'], GLOBAL_SCOPE)
    await gate.grantToRole('support', ['tickets:*'], GLOBAL_SCOPE)
    await gate.assignRole('u1', 'support', GLOBAL_SCOPE)

    expect(await can({ id: 'u1' }, 'billing:read')).toBe(true)
    const report = await ask({ id: 'u1' })
    expect(report.roles).toEqual(['support'])
    expect(report.permissions).toEqual(['billing:read', 'tickets:*'])
    expect(report.grants).toEqual([
      { permission: 'billing:read', source: 'direct', scope: GLOBAL_SCOPE },
      { permission: 'tickets:*', source: 'role', scope: GLOBAL_SCOPE, role: 'support' },
    ])
    await app.shutdown()
  })

  it('includes live temporary grants with their expiry, and drops them once expired', async () => {
    const { app, gate, ask, setNow } = await setup()
    const grant = await runWithContext({ tenant: { id: 'acme' } }, () =>
      gate.grantTemporarily('u1', ['reports:export'], { ttlMs: 500 }),
    )

    expect((await ask({ id: 'u1' })).grants).toEqual([
      { permission: 'reports:export', source: 'temporary', scope: 'acme', id: grant.id, expiresAt: 1_500 },
    ])
    setNow(1_500)
    expect((await ask({ id: 'u1' })).permissions).toEqual([])
    await app.shutdown()
  })

  it('includes delegations, narrowed to what the delegator holds, with the earliest expiry', async () => {
    const { app, gate, store, ask, can } = await setup()
    await store.grantToUser('boss', ['projects:read'], 'acme')
    const temp = await runWithContext({ tenant: { id: 'acme' } }, () =>
      gate.grantTemporarily('boss', ['invoices:*'], { expiresAt: 3_000 }),
    )
    const d = await runWithContext({ tenant: { id: 'acme' } }, () =>
      gate.delegate({ from: 'boss', to: 'deputy', permissions: ['projects:*', 'invoices:approve', 'hr:*'], expiresAt: 5_000 }),
    )

    const report = await ask({ id: 'deputy' })
    // `projects:*` ∩ `projects:read` = `projects:read`; `hr:*` meets nothing the boss holds.
    expect(report.permissions).toEqual(['invoices:approve', 'projects:read'])
    expect(report.grants).toEqual([
      { permission: 'projects:read', source: 'delegation', scope: 'acme', id: d.id, fromUserId: 'boss', expiresAt: 5_000 },
      // Rests on the boss's temporary grant, which ends first.
      { permission: 'invoices:approve', source: 'delegation', scope: 'acme', id: d.id, fromUserId: 'boss', expiresAt: temp.expiresAt },
    ])
    expect(await can({ id: 'deputy' }, 'invoices:approve')).toBe(true)
    expect(await can({ id: 'deputy' }, 'projects:write')).toBe(false)
    await app.shutdown()
  })

  it('reports the superAdmin bypass as "*"', async () => {
    const { app, ask } = await setup({ superAdmin: (user) => user['root'] === true })
    const report = await ask({ id: 'r', root: true })
    expect(report.superAdmin).toBe(true)
    expect(report.permissions).toEqual(['*'])
    expect(report.grants).toEqual([{ permission: '*', source: 'super-admin' }])
    expect((await ask({ id: 'plain' })).superAdmin).toBe(false)
    await app.shutdown()
  })

  it('agrees with gate.can() on every probe (the menu and the server tell the same story)', async () => {
    const { app, gate, store, ask, can } = await setup()
    await store.grantToRole('editor', ['docs:*:edit', 'docs:read'], 'acme')
    await store.assignRole('u1', 'editor', 'acme')
    await store.grantToUser('u1', ['billing:read'], GLOBAL_SCOPE)
    await store.grantToUser('lead', ['docs:draft:*', 'team:*'], 'acme')
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      await gate.grantTemporarily('u1', ['audit:view'], { ttlMs: 10_000 })
      await gate.delegate({ from: 'lead', to: 'u1', permissions: ['docs:*:*', 'team:invite'] })
    })

    const report = await ask({ id: 'u1' })
    const probes = [
      'docs:draft:edit', 'docs:draft:publish', 'docs:final:publish', 'docs:read', 'docs:write',
      'billing:read', 'billing:write', 'audit:view', 'team:invite', 'team:remove', 'hr:read',
    ]
    for (const probe of probes) {
      expect(permitted(report.permissions, probe), probe).toBe(await can({ id: 'u1' }, probe))
    }
    // …and in another tenant, only the global grant follows the user.
    const elsewhere = await ask({ id: 'u1' }, 'globex')
    expect(elsewhere.permissions).toEqual(['billing:read'])
    await app.shutdown()
  })
})

describe('Melhorias 3 · hasRole() is role membership, not the superAdmin bypass', () => {
  it('a super admin is not a member of roles they do not hold', async () => {
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, scope: () => GLOBAL_SCOPE, superAdmin: (u) => u['root'] === true })
    await store.assignRole('r', 'auditor', GLOBAL_SCOPE)
    const root = { id: 'r', root: true }

    expect(await gate.hasRole(root, 'billing-manager')).toBe(false)
    expect(await gate.hasRole(root, 'auditor')).toBe(true)
    expect(await gate.isSuperAdmin(root)).toBe(true)
    expect(await gate.isSuperAdmin({ id: 'x' })).toBe(false)
    // The bypass still decides checks.
    expect(await gate.can(root, 'billing:refund')).toBe(true)
  })
})
