import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { HookBus } from '@basaltkit/core'
import {
  AuthRequiredGuardError,
  Gate,
  GLOBAL_SCOPE,
  MemoryAccessStore,
  MissingPolicyFilterError,
  definePolicy,
  type GateOptions,
  type ListFilter,
  type Policy,
  type PolicyUser,
} from '../src/index.js'

interface Doc {
  ownerId: string
}
type Where = { ownerId: string } | { OR: unknown[] }

const isAdmin = (u: PolicyUser) => Array.isArray(u.roles) && u.roles.includes('admin')

const DocPolicy = definePolicy<Doc, Where>(
  'doc',
  { read: (u, d) => isAdmin(u) || d.ownerId === u.id, update: (u, d) => d.ownerId === u.id },
  {
    filters: {
      read: (u) => (isAdmin(u) ? true : { ownerId: u.id }),
      update: async (u) => (u['banned'] ? false : { ownerId: u.id }),
    },
  },
)

const NoFilterPolicy = definePolicy<Doc>('note', { read: () => true })

const make = (over: Partial<GateOptions> = {}) => {
  const store = new MemoryAccessStore()
  return { store, gate: new Gate({ store, policies: [DocPolicy, NoFilterPolicy], ...over }) }
}

const user = { id: 'u1' }

describe('gate.listFilter — results', () => {
  it('returns a where verbatim, true as unrestricted, false as none, async filters too', async () => {
    const { gate } = make()
    expect(await gate.listFilter(user, 'doc:read')).toEqual({ kind: 'where', where: { ownerId: 'u1' } })
    expect(await gate.listFilter({ id: 'a', roles: ['admin'] }, 'doc:read')).toEqual({ kind: 'unrestricted' })
    expect(await gate.listFilter({ id: 'b', banned: true }, 'doc:update')).toEqual({ kind: 'none' })
    expect(await gate.listFilter(user, 'doc:update')).toEqual({ kind: 'where', where: { ownerId: 'u1' } })
  })

  it('returns the same object the filter produced (no copy)', async () => {
    const where = { OR: [] }
    const gate = new Gate({
      store: new MemoryAccessStore(),
      policies: [definePolicy('x', { read: () => true }, { filters: { read: () => where } })],
    })
    const f = await gate.listFilter(user, 'x:read')
    expect(f.kind === 'where' && f.where).toBe(where)
  })

  it('superAdmin is unrestricted and the filter never runs', async () => {
    const filter = vi.fn(() => ({ ownerId: 'nobody' }))
    const gate = new Gate({
      store: new MemoryAccessStore(),
      superAdmin: (u) => u.id === 'root',
      policies: [definePolicy('x', { read: () => false }, { filters: { read: filter } })],
    })
    expect(await gate.listFilter({ id: 'root' }, 'x:read')).toEqual({ kind: 'unrestricted' })
    expect(filter).not.toHaveBeenCalled()
  })

  it('a filter returning null or undefined throws a TypeError naming the permission', async () => {
    for (const value of [null, undefined]) {
      const gate = new Gate({
        store: new MemoryAccessStore(),
        policies: [definePolicy('x', { read: () => true }, { filters: { read: () => value as never } })],
      })
      await expect(gate.listFilter(user, 'x:read')).rejects.toThrow(TypeError)
      await expect(gate.listFilter(user, 'x:read')).rejects.toThrow(/x:read/)
    }
  })

  it('a truthy non-true value is a where, never unrestricted', async () => {
    const gate = new Gate({
      store: new MemoryAccessStore(),
      policies: [definePolicy('x', { read: () => true }, { filters: { read: () => 1 as never } })],
    })
    expect(await gate.listFilter(user, 'x:read')).toEqual({ kind: 'where', where: 1 })
  })
})

describe('gate.listFilter — fails closed', () => {
  it('throws MissingPolicyFilterError for a policy without filters, an unknown action, an unknown resource', async () => {
    const { gate } = make()
    for (const p of ['note:read', 'doc:delete', 'nope:read']) {
      await expect(gate.listFilter(user, p)).rejects.toBeInstanceOf(MissingPolicyFilterError)
    }
  })

  it("throws even with onMissingPolicy: 'rbac' and an RBAC grant", async () => {
    const { store, gate } = make({ onMissingPolicy: 'rbac' })
    await store.grantToUser('u1', ['*'], GLOBAL_SCOPE)
    await expect(gate.listFilter(user, 'note:read')).rejects.toBeInstanceOf(MissingPolicyFilterError)
    await expect(gate.listFilter(user, 'doc:delete')).rejects.toBeInstanceOf(MissingPolicyFilterError)
  })

  it('the error carries the code, the permission and the registered filters', async () => {
    const { gate } = make()
    const error = (await gate.listFilter(user, 'doc:delete').catch((e: unknown) => e)) as MissingPolicyFilterError
    expect(error.code).toBe('PERMISSION_FILTER_MISSING')
    expect(error.status).toBe(500)
    expect(error.message).toContain('doc:delete')
    expect(error.message).toContain('doc:read')
    expect(error.message).toContain('doc:update')
    expect(error.message).toContain('filters: { delete')
  })

  it('never reaches Object.prototype', async () => {
    const { gate } = make()
    for (const p of ['doc:constructor', 'doc:__proto__', 'doc:toString', 'doc:hasOwnProperty']) {
      await expect(gate.listFilter(user, p)).rejects.toBeInstanceOf(MissingPolicyFilterError)
    }
  })

  it('a hand-built Policy whose filters object has a prototype does not leak it', async () => {
    const proto = { secret: () => true }
    const filters = Object.create(proto) as Record<string, () => unknown>
    filters['read'] = () => ({ ownerId: 'u1' })
    const policy: Policy<never> = { resource: 'hand', checks: { read: () => true, secret: () => true }, filters }
    const gate = new Gate({ store: new MemoryAccessStore() }).register(policy)
    expect(await gate.listFilter(user, 'hand:read')).toEqual({ kind: 'where', where: { ownerId: 'u1' } })
    await expect(gate.listFilter(user, 'hand:secret')).rejects.toBeInstanceOf(MissingPolicyFilterError)
  })

  it('only two segments select a filter', async () => {
    const { gate } = make()
    await expect(gate.listFilter(user, 'doc:read:x')).rejects.toBeInstanceOf(MissingPolicyFilterError)
    await expect(gate.listFilter(user, 'doc')).rejects.toBeInstanceOf(MissingPolicyFilterError)
  })

  it('an invalid user is unauthenticated; a malformed permission is a TypeError', async () => {
    const { gate } = make()
    for (const bad of [null, undefined, {}, { id: '' }, { id: 1 }]) {
      await expect(gate.listFilter(bad as never, 'doc:read')).rejects.toBeInstanceOf(AuthRequiredGuardError)
    }
    for (const p of ['', 'doc:', ':read', 'doc: read', 'a::b', 42]) {
      await expect(gate.listFilter(user, p as never)).rejects.toThrow(TypeError)
    }
  })
})

describe('definePolicy / register — filters validation', () => {
  it('rejects a filter with no matching check', () => {
    expect(() => definePolicy('x', { read: () => true }, { filters: { list: () => true } })).toThrow(
      'definePolicy(x): filter "list" has no matching check',
    )
  })

  it('rejects a non-function filter and a non-object filters value', () => {
    expect(() => definePolicy('x', { read: () => true }, { filters: { read: 'yes' as never } })).toThrow(TypeError)
    for (const bad of [null, 'read', 1, [() => true]]) {
      expect(() => definePolicy('x', { read: () => true }, { filters: bad as never })).toThrow(TypeError)
    }
  })

  it('an inherited check does not pair with a filter', () => {
    const checks = Object.create({ read: () => true }) as Record<string, () => boolean>
    expect(() => definePolicy('x', checks, { filters: { read: () => true } })).toThrow(/no matching check/)
  })

  it('register() validates a hand-built Policy the same way', () => {
    const gate = new Gate({ store: new MemoryAccessStore() })
    expect(() => gate.register({ resource: 'x', checks: { read: () => true }, filters: { list: () => true } })).toThrow(
      /no matching check/,
    )
    expect(() => gate.register({ resource: 'x', checks: {}, filters: null as never })).toThrow(TypeError)
  })

  it('a policy without filters carries no filters key', () => {
    expect('filters' in NoFilterPolicy).toBe(false)
  })

  it('regression: filters survive gate.register() and the policies option', async () => {
    const viaRegister = new Gate({ store: new MemoryAccessStore() }).register(DocPolicy)
    const viaOption = new Gate({ store: new MemoryAccessStore(), policies: [DocPolicy] })
    for (const gate of [viaRegister, viaOption]) {
      expect(await gate.listFilter(user, 'doc:read')).toEqual({ kind: 'where', where: { ownerId: 'u1' } })
    }
  })

  it('register() snapshots: mutating the original filters afterwards changes nothing', async () => {
    const filters: Record<string, () => unknown> = { read: () => ({ a: 1 }) }
    const gate = new Gate({ store: new MemoryAccessStore() }).register({
      resource: 'm',
      checks: { read: () => true },
      filters,
    })
    filters['read'] = () => true
    expect(await gate.listFilter(user, 'm:read')).toEqual({ kind: 'where', where: { a: 1 } })
  })
})

describe('gate.listFilter — side effects and independence', () => {
  it('emits no hook and records no denial, even on none or a missing filter', async () => {
    const hooks = new HookBus()
    const emitted: string[] = []
    hooks.onAny((name) => {
      emitted.push(String(name))
    })
    const { gate } = make({ hooks })
    await gate.listFilter({ id: 'b', banned: true }, 'doc:update')
    await gate.listFilter(user, 'doc:read')
    await gate.listFilter(user, 'note:read').catch(() => undefined)
    expect(emitted).toEqual([])
  })

  it('RBAC does not decide: no grant still gets the policy filter', async () => {
    const { gate } = make()
    expect(await gate.listFilter(user, 'doc:read')).toEqual({ kind: 'where', where: { ownerId: 'u1' } })
  })

  it('can() is unchanged by filters', async () => {
    const { gate } = make()
    expect(await gate.can(user, 'doc:read', { ownerId: 'u1' })).toBe(true)
    expect(await gate.can(user, 'doc:read', { ownerId: 'u2' })).toBe(false)
  })
})

describe('types', () => {
  it('Policy<Doc, Where> fits GateOptions.policies; listFilter<X>() returns ListFilter<X>', () => {
    const policy: Policy<Doc, { ownerId: string }> = definePolicy<Doc, { ownerId: string }>(
      'doc',
      { read: () => true },
      { filters: { read: (u) => ({ ownerId: u.id }) } },
    )
    const policies: NonNullable<GateOptions['policies']> = [policy]
    expect(policies).toHaveLength(1)
    const gate = new Gate({ store: new MemoryAccessStore() })
    expectTypeOf(gate.listFilter<{ ownerId: string }>).returns.toEqualTypeOf<Promise<ListFilter<{ ownerId: string }>>>()
    expectTypeOf(gate.listFilter).returns.toEqualTypeOf<Promise<ListFilter<unknown>>>()
  })
})
