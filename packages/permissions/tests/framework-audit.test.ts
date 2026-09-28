import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { route, type RequestEnricher } from '@basaltkit/http'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import {
  AuthRequiredGuardError,
  Gate,
  GATE,
  GLOBAL_SCOPE,
  MemoryAccessStore,
  MemoryDelegationStore,
  MemoryTemporaryGrantStore,
  MissingPolicyError,
  ScopeRequiredError,
  definePolicy,
  permissionsPlugin,
  type Delegation,
  type DelegationStore,
  type Policy,
  type TemporaryGrant,
  type TemporaryGrantStore,
} from '../src/index.js'

/**
 * Regression tests for the framework audit (FA-002..FA-006, FA-H14). Each case
 * was first reproduced against the shipped package asserting the DEFECTIVE
 * behaviour; the expectations here are the inverted, fixed behaviour.
 */

const projectPolicy = definePolicy<{ ownerId: string }>('project', {
  update: (user, project) => project.ownerId === user.id,
})

const gate = (extra: Partial<ConstructorParameters<typeof Gate>[0]> = {}) =>
  new Gate({ store: new MemoryAccessStore(), policies: [projectPolicy as Policy<never>], ...extra })

describe('FA-002 · policy lookup never walks Object.prototype', () => {
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'])(
    '"project:%s" is a missing policy, not a grant (and not a TypeError)',
    async (action) => {
      const g = gate()
      await expect(g.can({ id: 'eve' }, `project:${action}`, { ownerId: 'bob' })).rejects.toBeInstanceOf(
        MissingPolicyError,
      )
      await expect(g.authorize({ id: 'eve' }, `project:${action}`, { ownerId: 'bob' })).rejects.toBeInstanceOf(
        MissingPolicyError,
      )
    },
  )

  it('controls: a real denying action denies; an unknown action is a missing policy', async () => {
    const g = gate()
    expect(await g.can({ id: 'eve' }, 'project:update', { ownerId: 'bob' })).toBe(false)
    expect(await g.can({ id: 'eve' }, 'project:update', { ownerId: 'eve' })).toBe(true)
    await expect(g.can({ id: 'eve' }, 'project:archive', { ownerId: 'bob' })).rejects.toBeInstanceOf(MissingPolicyError)
  })

  it('with onMissingPolicy: "rbac", a prototype name falls through to RBAC (deny), never to Object', async () => {
    const g = gate({ onMissingPolicy: 'rbac' })
    expect(await g.can({ id: 'eve' }, 'project:constructor', { ownerId: 'bob' })).toBe(false)
  })

  it('a hand-built Policy (not through definePolicy) is snapshotted to own entries too', async () => {
    const g = new Gate({ store: new MemoryAccessStore() })
    g.register({ resource: 'doc', checks: { read: () => true } } as Policy<never>)
    await expect(g.can({ id: 'eve' }, 'doc:constructor', {})).rejects.toBeInstanceOf(MissingPolicyError)
    expect(await g.can({ id: 'eve' }, 'doc:read', {})).toBe(true)
  })

  it('only a strict `true` from a check authorizes', async () => {
    const g = new Gate({
      store: new MemoryAccessStore(),
      policies: [definePolicy('doc', { read: () => 'yes' as unknown as boolean, list: async () => 1 as unknown as boolean })],
    })
    expect(await g.can({ id: 'eve' }, 'doc:read', {})).toBe(false)
    expect(await g.can({ id: 'eve' }, 'doc:list', {})).toBe(false)
  })

  it('definePolicy refuses non-function checks and a malformed resource', () => {
    expect(() => definePolicy('doc', { read: 'yes' } as never)).toThrow(TypeError)
    expect(() => definePolicy('', {})).toThrow(TypeError)
    expect(() => definePolicy('a:b', {})).toThrow(TypeError)
  })

  it('a malformed permission is refused on entry', async () => {
    const g = gate()
    for (const bad of ['', 'project: update', 'project:update\n', 42, undefined]) {
      await expect(g.can({ id: 'eve' }, bad as never)).rejects.toBeInstanceOf(TypeError)
    }
  })
})

describe('FA-003 · only an exact `resource:action` selects a policy check', () => {
  it('"project:update:billing" is a missing policy, not decided by the "update" check', async () => {
    const g = gate()
    await expect(g.can({ id: 'eve' }, 'project:update:billing', { ownerId: 'eve' })).rejects.toBeInstanceOf(
      MissingPolicyError,
    )
  })

  it('with onMissingPolicy: "rbac" it is answered by the grants for the full permission', async () => {
    const store = new MemoryAccessStore()
    const g = new Gate({ store, policies: [projectPolicy as Policy<never>], onMissingPolicy: 'rbac' })
    expect(await g.can({ id: 'eve' }, 'project:update:billing', { ownerId: 'eve' })).toBe(false)
    await store.grantToUser('eve', ['project:update:billing'], GLOBAL_SCOPE)
    expect(await g.can({ id: 'eve' }, 'project:update:billing', { ownerId: 'bob' })).toBe(true)
  })
})

describe('FA-004 · a missing user id is not a user', () => {
  it('grants cannot be written for undefined/null/empty ids', async () => {
    const g = gate()
    for (const id of [undefined, null, '']) {
      await expect(g.grantToUser(id as never, ['admin:*'], GLOBAL_SCOPE)).rejects.toBeInstanceOf(TypeError)
      await expect(g.assignRole(id as never, 'admin', GLOBAL_SCOPE)).rejects.toBeInstanceOf(TypeError)
      await expect(g.removeRole(id as never, 'admin', GLOBAL_SCOPE)).rejects.toBeInstanceOf(TypeError)
    }
  })

  it('MemoryAccessStore refuses them too, so the undefined/null bucket cannot be filled', async () => {
    const store = new MemoryAccessStore()
    await expect(store.grantToUser(undefined as never, ['admin:*'], GLOBAL_SCOPE)).rejects.toBeInstanceOf(TypeError)
    await expect(store.assignRole(null as never, 'admin', GLOBAL_SCOPE)).rejects.toBeInstanceOf(TypeError)
  })

  it('can/authorize/hasRole with no usable id throw AUTH_REQUIRED (401), not a TypeError', async () => {
    const g = gate()
    for (const user of [undefined, null, {}, { id: null }, { id: '' }, { id: 7 }]) {
      await expect(g.can(user as never, 'admin:delete')).rejects.toBeInstanceOf(AuthRequiredGuardError)
      await expect(g.authorize(user as never, 'admin:delete')).rejects.toBeInstanceOf(AuthRequiredGuardError)
      await expect(g.hasRole(user as never, 'admin')).rejects.toBeInstanceOf(AuthRequiredGuardError)
    }
  })

  it('the meta.can guard treats a user object without an id as unauthenticated (401)', async () => {
    const emptyUser = definePlugin({
      name: 'empty-user',
      register({ container }) {
        const enricher: RequestEnricher = ({ context }) => {
          context.user = {} as never
        }
        ensureMetadata(container).add('http:enrichers', enricher)
      },
    })
    const app = await createApp({
      plugins: [
        emptyUser,
        permissionsPlugin({ store: new MemoryAccessStore() }),
        fastifyPlugin({
          routes: [route({ method: 'GET', url: '/x', meta: { can: 'admin:delete' }, handler: () => ({ ok: true }) })],
        }),
      ],
    }).boot()
    const r = await app.container.get(FASTIFY).inject({ method: 'GET', url: '/x' })
    expect(r.statusCode).toBe(401)
    await app.shutdown()
  })
})

describe('FA-005 · the Gate re-verifies what the grant/delegation stores return', () => {
  const lax = (grants: Partial<TemporaryGrant>[]): TemporaryGrantStore => ({
    async add() {},
    async revoke() {},
    async all() {
      return grants as TemporaryGrant[]
    },
    async activeFor() {
      return grants as TemporaryGrant[]
    },
  })
  const base = { id: 'g1', userId: 'u', scope: GLOBAL_SCOPE, permissions: ['reports:read'] }

  it('an expired grant returned by a lax store is ignored', async () => {
    const g = gate({ temporaryGrants: lax([{ ...base, expiresAt: 0 }]), now: () => 1_000_000 })
    expect(await g.can({ id: 'u' }, 'reports:read')).toBe(false)
  })

  it('a grant for another user, another scope, or with a non-finite expiry is ignored', async () => {
    const now = () => 1_000
    for (const grant of [
      { ...base, userId: 'someone-else', expiresAt: 5_000 },
      { ...base, scope: 'acme', expiresAt: 5_000 },
      { ...base, expiresAt: Infinity },
      { ...base, expiresAt: Number.NaN },
      { ...base, expiresAt: '9999999999999' as never },
    ]) {
      const g = gate({ temporaryGrants: lax([grant]), now })
      expect(await g.can({ id: 'u' }, 'reports:read')).toBe(false)
    }
    // Control: a live grant from the same lax store is honoured.
    expect(await gate({ temporaryGrants: lax([{ ...base, expiresAt: 5_000 }]), now }).can({ id: 'u' }, 'reports:read')).toBe(true)
  })

  it('an expired delegation returned by a lax store is ignored', async () => {
    const store = new MemoryAccessStore()
    await store.grantToUser('boss', ['projects:read'], GLOBAL_SCOPE)
    const delegation = (d: Partial<Delegation>): DelegationStore => ({
      async add() {},
      async revoke() {},
      async all() {
        return [d as Delegation]
      },
      async activeFrom() {
        return [d as Delegation]
      },
      async activeTo() {
        return [d as Delegation]
      },
    })
    const d = { id: 'd1', fromUserId: 'boss', toUserId: 'temp', permissions: ['projects:read'], scope: GLOBAL_SCOPE, createdAt: 0 }
    const now = () => 1_000
    const check = (x: Partial<Delegation>) => new Gate({ store, delegations: delegation(x), now }).can({ id: 'temp' }, 'projects:read')
    expect(await check({ ...d, expiresAt: 500 })).toBe(false)
    expect(await check({ ...d, toUserId: 'other' })).toBe(false)
    expect(await check({ ...d, scope: 'acme' })).toBe(false)
    expect(await check({ ...d, expiresAt: Infinity })).toBe(false)
    // Controls: live and open-ended (undefined, or NULL from a SQL row).
    expect(await check({ ...d, expiresAt: 5_000 })).toBe(true)
    expect(await check(d)).toBe(true)
    expect(await check({ ...d, expiresAt: null as never })).toBe(true)
  })

  it('grantTemporarily refuses an infinite, past or non-numeric deadline', async () => {
    const g = gate({ temporaryGrants: new MemoryTemporaryGrantStore(), now: () => 1_000 })
    await expect(g.grantTemporarily('u', ['x:y'], { expiresAt: Infinity })).rejects.toBeInstanceOf(TypeError)
    await expect(g.grantTemporarily('u', ['x:y'], { expiresAt: 1_000 })).rejects.toBeInstanceOf(TypeError)
    await expect(g.grantTemporarily('u', ['x:y'], { ttlMs: Infinity })).rejects.toBeInstanceOf(TypeError)
    await expect(g.grantTemporarily('u', ['x:y'], { ttlMs: 0 })).rejects.toBeInstanceOf(TypeError)
    await expect(g.grantTemporarily('u', ['x:y'], { ttlMs: -5 })).rejects.toBeInstanceOf(TypeError)
  })

  it('delegate refuses an infinite or past deadline', async () => {
    const g = gate({ delegations: new MemoryDelegationStore(), now: () => 1_000 })
    await expect(g.delegate({ from: 'a', to: 'b', permissions: ['x:y'], expiresAt: Infinity })).rejects.toBeInstanceOf(TypeError)
    await expect(g.delegate({ from: 'a', to: 'b', permissions: ['x:y'], expiresAt: 10 })).rejects.toBeInstanceOf(TypeError)
    await expect(g.delegate({ from: undefined as never, to: 'b', permissions: ['x:y'] })).rejects.toBeInstanceOf(TypeError)
  })
})

describe('FA-H14 · grantTemporarily needs a deadline', () => {
  it('with neither ttlMs nor expiresAt it throws instead of writing an already-expired grant', async () => {
    const temporaryGrants = new MemoryTemporaryGrantStore()
    const g = gate({ temporaryGrants, now: () => 1_000 })
    await expect(g.grantTemporarily('u', ['reports:read'])).rejects.toThrow(/ttlMs or expiresAt/)
    await expect(g.grantTemporarily('u', ['reports:read'], {})).rejects.toBeInstanceOf(TypeError)
    expect(await temporaryGrants.all()).toEqual([])
  })
})

describe('FA-006 · scope-less writes outside a tenant fail closed when tenancy is active', () => {
  const multiTenant = () => gate({ tenancyActive: () => true, temporaryGrants: new MemoryTemporaryGrantStore(), delegations: new MemoryDelegationStore() })

  it('assignRole() outside a tenant context throws instead of writing a platform-wide role', async () => {
    const g = multiTenant()
    await expect(runWithContext({}, () => g.assignRole('u', 'admin'))).rejects.toBeInstanceOf(ScopeRequiredError)
    await expect(g.assignRole('u', 'admin')).rejects.toBeInstanceOf(ScopeRequiredError) // no context at all
    expect(await runWithContext({ tenant: { id: 'acme' } } as never, () => g.hasRole({ id: 'u' }, 'admin'))).toBe(false)
    expect(await runWithContext({ tenant: { id: 'globex' } } as never, () => g.hasRole({ id: 'u' }, 'admin'))).toBe(false)
  })

  it('every write method fails closed the same way', async () => {
    const g = multiTenant()
    const writes: (() => Promise<unknown>)[] = [
      () => g.removeRole('u', 'admin'),
      () => g.grantToRole('admin', ['x:y']),
      () => g.grantToUser('u', ['x:y']),
      () => g.grantTemporarily('u', ['x:y'], { ttlMs: 1_000 }),
      () => g.delegate({ from: 'a', to: 'b', permissions: ['x:y'] }),
    ]
    for (const write of writes) await expect(runWithContext({}, write)).rejects.toBeInstanceOf(ScopeRequiredError)
  })

  it('inside a tenant, a scope-less write lands in that tenant only', async () => {
    const g = multiTenant()
    await runWithContext({ tenant: { id: 'acme' } } as never, () => g.assignRole('u', 'admin'))
    expect(await runWithContext({ tenant: { id: 'acme' } } as never, () => g.hasRole({ id: 'u' }, 'admin'))).toBe(true)
    expect(await runWithContext({ tenant: { id: 'globex' } } as never, () => g.hasRole({ id: 'u' }, 'admin'))).toBe(false)
  })

  it('an explicit GLOBAL_SCOPE, or allowGlobalWrites, still writes a global grant', async () => {
    const g = multiTenant()
    await runWithContext({}, () => g.assignRole('u', 'admin', GLOBAL_SCOPE))
    expect(await runWithContext({ tenant: { id: 'acme' } } as never, () => g.hasRole({ id: 'u' }, 'admin'))).toBe(true)

    const opted = gate({ tenancyActive: () => true, allowGlobalWrites: true })
    await runWithContext({}, () => opted.assignRole('v', 'admin'))
    expect(await runWithContext({ tenant: { id: 'acme' } } as never, () => opted.hasRole({ id: 'v' }, 'admin'))).toBe(true)
  })

  it('single-tenant apps (no tenancy) keep writing to the global scope without ceremony', async () => {
    const g = gate()
    await g.assignRole('u', 'admin')
    await g.grantToUser('u', ['x:y'])
    expect(await g.hasRole({ id: 'u' }, 'admin')).toBe(true)
    expect(await g.can({ id: 'u' }, 'x:y')).toBe(true)
  })

  it('permissionsPlugin reads the tenancy:active marker', async () => {
    const withTenancy = await createApp({
      plugins: [
        definePlugin({ name: 'fake-tenancy', register: ({ container }) => ensureMetadata(container).add('tenancy:active', true) }),
        permissionsPlugin({ store: new MemoryAccessStore() }),
        fastifyPlugin({ routes: [] }),
      ],
    }).boot()
    await expect(runWithContext({}, () => withTenancy.container.get(GATE).assignRole('u', 'admin'))).rejects.toBeInstanceOf(
      ScopeRequiredError,
    )
    await withTenancy.shutdown()

    const single = await createApp({
      plugins: [permissionsPlugin({ store: new MemoryAccessStore() }), fastifyPlugin({ routes: [] })],
    }).boot()
    await runWithContext({}, () => single.container.get(GATE).assignRole('u', 'admin'))
    expect(await single.container.get(GATE).hasRole({ id: 'u' }, 'admin')).toBe(true)
    await single.shutdown()
  })
})
