import { describe, expect, it } from 'vitest'
import { createApp, HookBus, runWithContext } from '@basaltkit/core'
import {
  accessRoutes,
  Gate,
  GATE,
  GLOBAL_SCOPE,
  LEGACY_GLOBAL_SCOPE,
  MemoryAccessStore,
  PermissionDeniedError,
  permissionsPlugin,
} from '../src/index.js'

/**
 * BK-016 · A role catalogue defined once must apply to roles assigned per tenant.
 *
 * `@basaltkit/teams` mirrors every membership as `access.assignRole(user, role,
 * tenantId)`. The Gate looked a role's permissions up only in the scope where
 * the role was held, so "owner = *" granted in GLOBAL_SCOPE never reached a
 * tenant owner — apps had to copy the catalogue into every tenant.
 */

/** The structural contract teams uses (`RoleAssigner` in @basaltkit/teams). */
interface RoleAssigner {
  assignRole(userId: string, role: string, scope: string): Promise<void>
  removeRole(userId: string, role: string, scope: string): Promise<void>
}

const inTenant = <T>(id: string, fn: () => Promise<T>): Promise<T> => runWithContext({ tenant: { id } }, fn)
const central = <T>(fn: () => Promise<T>): Promise<T> => runWithContext({}, fn)

const catalog = {
  owner: ['*'],
  admin: ['projects:*', 'members:invite'],
  member: ['projects:read'],
}

describe('BK-016 · roleCatalog', () => {
  it('owner assigned in tenant A gets catalogue permissions in A, nothing in B, nothing globally', async () => {
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, roleCatalog: catalog })
    // What `Teams.addMember('acme', 'ada', 'owner')` mirrors.
    const access: RoleAssigner = gate
    await access.assignRole('ada', 'owner', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'ada' }, 'billing:refund'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'ada' }, 'projects:delete'))).toBe(true)
    expect(await inTenant('globex', () => gate.can({ id: 'ada' }, 'billing:refund'))).toBe(false)
    expect(await inTenant('globex', () => gate.can({ id: 'ada' }, 'projects:read'))).toBe(false)
    expect(await central(() => gate.can({ id: 'ada' }, 'billing:refund'))).toBe(false)
  })

  it('segment wildcards in the catalogue match exactly like stored grants', async () => {
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, roleCatalog: catalog })
    await gate.assignRole('bob', 'admin', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'projects:delete'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'members:invite'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'members:remove'))).toBe(false)
    // 'projects:*' is two segments — it does not cover a three-segment permission.
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'projects:tasks:delete'))).toBe(false)
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'billing:refund'))).toBe(false)
  })

  it('is a union with store-defined role permissions', async () => {
    const store = new MemoryAccessStore()
    await store.grantToRole('member', ['reports:read'], 'acme')
    const gate = new Gate({ store, roleCatalog: catalog })
    await gate.assignRole('cy', 'member', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'cy' }, 'projects:read'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'cy' }, 'reports:read'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'cy' }, 'projects:update'))).toBe(false)
  })

  it('a role held globally grants its catalogue permissions everywhere (global roles already do)', async () => {
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, roleCatalog: catalog })
    await gate.assignRole('staff', 'member', GLOBAL_SCOPE)

    expect(await inTenant('acme', () => gate.can({ id: 'staff' }, 'projects:read'))).toBe(true)
    expect(await central(() => gate.can({ id: 'staff' }, 'projects:read'))).toBe(true)
    expect(await central(() => gate.can({ id: 'staff' }, 'projects:update'))).toBe(false)
  })

  it('a role not in the catalogue grants nothing from it; prototype keys are not roles', async () => {
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, roleCatalog: catalog })
    await gate.assignRole('eve', 'constructor', 'acme')
    await gate.assignRole('eve', '__proto__', 'acme')
    await gate.assignRole('eve', 'guest', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'eve' }, 'projects:read'))).toBe(false)
  })

  it('removing the tenant role removes the catalogue grant', async () => {
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, roleCatalog: catalog })
    await gate.assignRole('ada', 'owner', 'acme')
    await gate.removeRole('ada', 'owner', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'ada' }, 'projects:read'))).toBe(false)
  })

  it('is snapshotted at construction — mutating the passed object later changes nothing', async () => {
    const mutable: Record<string, string[]> = { member: ['projects:read'] }
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, roleCatalog: mutable })
    await gate.assignRole('cy', 'member', 'acme')
    mutable['member']!.push('*')
    mutable['intruder'] = ['*']

    expect(await inTenant('acme', () => gate.can({ id: 'cy' }, 'billing:refund'))).toBe(false)
  })

  it('refuses malformed catalogues at construction', () => {
    const store = new MemoryAccessStore()
    expect(() => new Gate({ store, roleCatalog: { owner: '*' as unknown as string[] } })).toThrow(TypeError)
    expect(() => new Gate({ store, roleCatalog: { owner: [''] } })).toThrow(TypeError)
    expect(() => new Gate({ store, roleCatalog: { owner: [42 as unknown as string] } })).toThrow(TypeError)
    expect(() => new Gate({ store, roleCatalog: { '': ['*'] } })).toThrow(TypeError)
  })

  it('delegation is bounded by the delegator’s catalogue permissions, in the delegator’s tenant only', async () => {
    const { MemoryDelegationStore } = await import('../src/index.js')
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, roleCatalog: catalog, delegations: new MemoryDelegationStore() })
    await gate.assignRole('ada', 'owner', 'acme')
    await gate.delegate({ from: 'ada', to: 'bob', permissions: ['billing:*'], scope: 'acme' })

    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'billing:refund'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'projects:read'))).toBe(false)
    expect(await inTenant('globex', () => gate.can({ id: 'bob' }, 'billing:refund'))).toBe(false)
  })

  it('hasRole and audience roles are unaffected — the catalogue grants permissions, not roles', async () => {
    const store = new MemoryAccessStore()
    const gate = new Gate({ store, roleCatalog: catalog })
    await gate.assignRole('ada', 'owner', 'acme')

    expect(await inTenant('globex', () => gate.hasRole({ id: 'ada' }, 'owner'))).toBe(false)
    expect(await inTenant('globex', () => gate.audienceRoles('ada'))).toEqual([])
    expect(await inTenant('acme', () => gate.effectiveRoles('ada'))).toEqual(['owner'])
  })

  it('permissionsPlugin passes roleCatalog through to the Gate', async () => {
    const store = new MemoryAccessStore()
    const app = await createApp({ plugins: [permissionsPlugin({ store, roleCatalog: catalog })] }).boot()
    const gate = app.container.get(GATE)
    await gate.assignRole('ada', 'owner', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'ada' }, 'anything:at:all'))).toBe(true)
    expect(await inTenant('globex', () => gate.can({ id: 'ada' }, 'anything:at:all'))).toBe(false)
    await app.shutdown()
  })

  it('authorize() in another tenant still refuses and emits permission:denied', async () => {
    const hooks = new HookBus()
    const denied: unknown[] = []
    hooks.on('permission:denied', (payload) => {
      denied.push(payload)
    })
    const gate = new Gate({ store: new MemoryAccessStore(), roleCatalog: catalog, hooks })
    await gate.assignRole('ada', 'owner', 'acme')

    await expect(inTenant('globex', () => gate.authorize({ id: 'ada' }, 'billing:refund'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
    await expect(inTenant('acme', () => gate.authorize({ id: 'ada' }, 'billing:refund'))).resolves.toBeUndefined()
    expect(denied).toEqual([{ userId: 'ada', permission: 'billing:refund', scope: 'globex' }])
  })

  it('GET /me/access reports catalogue permissions for the current tenant only', async () => {
    const store = new MemoryAccessStore()
    const app = await createApp({ plugins: [permissionsPlugin({ store, roleCatalog: catalog })] }).boot()
    await app.container.get(GATE).assignRole('bob', 'admin', 'acme')
    const [accessRoute] = accessRoutes()
    const ask = (tenant: string) =>
      runWithContext({ user: { id: 'bob' }, tenant: { id: tenant }, container: app.container }, () =>
        (accessRoute!.handler as (a: unknown) => Promise<{ roles: string[]; permissions: string[] }>)({}),
      )

    expect(await ask('acme')).toEqual({ roles: ['admin'], permissions: ['members:invite', 'projects:*'] })
    expect(await ask('globex')).toEqual({ roles: [], permissions: [] })
    await app.shutdown()
  })
})

describe('BK-016 · inheritGlobalRolePermissions', () => {
  async function setup(inherit?: boolean | string[], extra: Partial<ConstructorParameters<typeof Gate>[0]> = {}) {
    const store = new MemoryAccessStore()
    // The catalogue, stored once, globally.
    await store.grantToRole('owner', ['*'], GLOBAL_SCOPE)
    await store.grantToRole('admin', ['projects:*'], GLOBAL_SCOPE)
    const gate = new Gate({
      store,
      ...(inherit !== undefined ? { inheritGlobalRolePermissions: inherit } : {}),
      ...extra,
    })
    return { store, gate }
  }

  it('off by default — the historic per-scope lookup (a tenant owner gets nothing)', async () => {
    const { gate } = await setup()
    await gate.assignRole('ada', 'owner', 'acme')
    expect(await inTenant('acme', () => gate.can({ id: 'ada' }, 'projects:read'))).toBe(false)
  })

  it('on: a tenant-held role resolves its permissions from the global definition, in that tenant only', async () => {
    const { gate } = await setup(true)
    await gate.assignRole('ada', 'owner', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'ada' }, 'billing:refund'))).toBe(true)
    expect(await inTenant('globex', () => gate.can({ id: 'ada' }, 'billing:refund'))).toBe(false)
    expect(await central(() => gate.can({ id: 'ada' }, 'billing:refund'))).toBe(false)
  })

  it('unions the tenant’s own definition of the role with the global one', async () => {
    const { store, gate } = await setup(true)
    await store.grantToRole('admin', ['reports:read'], 'acme')
    await gate.assignRole('bob', 'admin', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'reports:read'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'projects:delete'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'billing:refund'))).toBe(false)
  })

  it('a list restricts which role names inherit (a tenant cannot self-assign a platform role)', async () => {
    const { store, gate } = await setup(['admin'])
    await store.grantToRole('platform-admin', ['*'], GLOBAL_SCOPE)
    await gate.assignRole('mallory', 'platform-admin', 'acme')
    await gate.assignRole('mallory', 'owner', 'acme')
    await gate.assignRole('bob', 'admin', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'mallory' }, 'billing:refund'))).toBe(false)
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'projects:update'))).toBe(true)
  })

  it('reads the legacy global definition only when readLegacyGlobalScope is on', async () => {
    const store = new MemoryAccessStore()
    await store.grantToRole('owner', ['*'], LEGACY_GLOBAL_SCOPE)
    const off = new Gate({ store, inheritGlobalRolePermissions: true })
    const on = new Gate({ store, inheritGlobalRolePermissions: true, readLegacyGlobalScope: true })
    await store.assignRole('ada', 'owner', 'acme')

    expect(await inTenant('acme', () => off.can({ id: 'ada' }, 'projects:read'))).toBe(false)
    expect(await inTenant('acme', () => on.can({ id: 'ada' }, 'projects:read'))).toBe(true)
    expect(await inTenant('globex', () => on.can({ id: 'ada' }, 'projects:read'))).toBe(false)
  })

  it('combines with roleCatalog', async () => {
    const { gate } = await setup(true, { roleCatalog: { member: ['projects:read'] } })
    await gate.assignRole('cy', 'member', 'acme')
    await gate.assignRole('bob', 'admin', 'acme')

    expect(await inTenant('acme', () => gate.can({ id: 'cy' }, 'projects:read'))).toBe(true)
    expect(await inTenant('acme', () => gate.can({ id: 'bob' }, 'projects:update'))).toBe(true)
    expect(await inTenant('globex', () => gate.can({ id: 'cy' }, 'projects:read'))).toBe(false)
  })
})
