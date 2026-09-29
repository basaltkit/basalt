import { describe, expect, it } from 'vitest'
import { Gate, GLOBAL_SCOPE } from '@basaltkit/permissions'
import {
  ColumnLengthError,
  type PermDelegationRow,
  type PermTemporaryGrantRow,
  PrismaDelegationStore,
  type PrismaPermissionsClient,
  PrismaTemporaryGrantStore,
  prismaAccessStore,
} from '../src/index.js'

/**
 * FA-H07 · durable TemporaryGrantStore / DelegationStore. Only the in-memory
 * stores existed, so a time-boxed grant or a delegation vanished on restart and
 * was invisible to every other instance.
 *
 * The fake below evaluates the subset of Prisma's `where` the stores use
 * (equality, `gt`/`lte` on dates, `null`, `OR`) — so a store that forgot its
 * `expiresAt > now` or scope filter fails here, not only against a database.
 */
type Row = Record<string, unknown>

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((alt) => matches(row, alt))
    const value = row[key]
    if (cond === null) return value === null
    if (cond instanceof Date || typeof cond !== 'object') {
      return value instanceof Date && cond instanceof Date ? value.getTime() === cond.getTime() : value === cond
    }
    const ops = cond as { gt?: Date; lte?: Date }
    if (!(value instanceof Date)) return false
    if (ops.gt !== undefined && !(value.getTime() > ops.gt.getTime())) return false
    if (ops.lte !== undefined && !(value.getTime() <= ops.lte.getTime())) return false
    return true
  })
}

function table<T extends Row>() {
  const rows: T[] = []
  return {
    rows,
    async findMany({ where = {} }: { where?: Row } = {}) {
      return rows.filter((r) => matches(r, where)).map((r) => ({ ...r })) as T[]
    },
    async upsert({ where, create, update }: { where: { id: string }; create: T; update: T }) {
      const index = rows.findIndex((r) => r['id'] === where.id)
      if (index === -1) rows.push({ ...create })
      else rows[index] = { ...rows[index]!, ...update }
      return {}
    },
    async deleteMany({ where }: { where: Row }) {
      const keep = rows.filter((r) => !matches(r, where))
      const count = rows.length - keep.length
      rows.splice(0, rows.length, ...keep)
      return { count }
    },
  }
}

function fakeClient() {
  const temporary = table<PermTemporaryGrantRow & Row>()
  const delegation = table<PermDelegationRow & Row>()
  const none = async () => []
  const client: PrismaPermissionsClient = {
    permUserRole: { findMany: none, createMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
    permUserPermission: { findMany: none, createMany: async () => ({ count: 0 }) },
    permRolePermission: { findMany: none, createMany: async () => ({ count: 0 }) },
    permTemporaryGrant: temporary,
    permDelegation: delegation,
  }
  return { client, temporary, delegation }
}

describe('FA-H07 · PrismaTemporaryGrantStore', () => {
  it('round-trips a grant and returns it only while live, for its user and scope', async () => {
    const { client, temporary } = fakeClient()
    const store = new PrismaTemporaryGrantStore(client)
    await store.add({ id: 'g1', userId: 'u1', permissions: ['reports:read'], scope: 'acme', expiresAt: 2_000, reason: 'audit' })
    await store.add({ id: 'g2', userId: 'u1', permissions: ['x:y'], scope: 'globex', expiresAt: 2_000 })

    expect(temporary.rows[0]!.expiresAt).toBeInstanceOf(Date)
    expect(await store.activeFor('u1', 'acme', 1_000)).toEqual([
      { id: 'g1', userId: 'u1', permissions: ['reports:read'], scope: 'acme', expiresAt: 2_000, reason: 'audit' },
    ])
    expect(await store.activeFor('u1', 'acme', 2_000)).toEqual([]) // expiry is exclusive
    expect(await store.activeFor('u2', 'acme', 1_000)).toEqual([])

    await store.revoke('g1')
    expect(await store.activeFor('u1', 'acme', 1_000)).toEqual([])
    expect((await store.all()).map((g) => g.id)).toEqual(['g2'])
  })

  it('reads a MySQL Json permissions column and prunes expired rows', async () => {
    const { client, temporary } = fakeClient()
    const store = new PrismaTemporaryGrantStore(client)
    temporary.rows.push({
      id: 'j', scope: 's', userId: 'u', permissions: ['a:b', 7, null], expiresAt: new Date(5_000), grantedBy: null, reason: null,
    })
    expect(await store.activeFor('u', 's', 0)).toEqual([{ id: 'j', userId: 'u', permissions: ['a:b'], scope: 's', expiresAt: 5_000 }])
    await store.add({ id: 'old', userId: 'u', permissions: ['a:b'], scope: 's', expiresAt: 100 })
    expect(await store.pruneExpired(5_000)).toBe(2)
    expect(await store.all()).toEqual([])
  })

  it('refuses malformed records instead of persisting them', async () => {
    const store = new PrismaTemporaryGrantStore(fakeClient().client)
    const ok = { id: 'g', userId: 'u', permissions: ['a:b'], scope: 's', expiresAt: 1_000 }
    for (const bad of [
      { ...ok, id: '' },
      { ...ok, userId: undefined },
      { ...ok, scope: '' },
      { ...ok, permissions: ['a', ''] },
      { ...ok, expiresAt: Number.POSITIVE_INFINITY },
      { ...ok, expiresAt: 9e15 },
      { ...ok, reason: 42 },
    ]) {
      await expect(store.add(bad as never), JSON.stringify(bad)).rejects.toBeInstanceOf(TypeError)
    }
  })

  it("honours columnLimits: 'mysql'", async () => {
    const store = new PrismaTemporaryGrantStore(fakeClient().client, { columnLimits: 'mysql' })
    await expect(
      store.add({ id: 'g', userId: 'u'.repeat(192), permissions: ['a:b'], scope: 's', expiresAt: 1_000 }),
    ).rejects.toBeInstanceOf(ColumnLengthError)
  })
})

describe('FA-H07 · PrismaDelegationStore', () => {
  it('returns open-ended and unexpired delegations, by direction and scope', async () => {
    const { client, delegation } = fakeClient()
    const store = new PrismaDelegationStore(client)
    await store.add({ id: 'd1', fromUserId: 'boss', toUserId: 'dep', permissions: ['p:*'], scope: 'acme', createdAt: 1 })
    await store.add({ id: 'd2', fromUserId: 'boss', toUserId: 'dep', permissions: ['q:r'], scope: 'acme', createdAt: 1, expiresAt: 500 })
    await store.add({ id: 'd3', fromUserId: 'boss', toUserId: 'dep', permissions: ['z:z'], scope: 'globex', createdAt: 1 })

    expect(delegation.rows[0]!.expiresAt).toBeNull()
    expect((await store.activeTo('dep', 'acme', 100)).map((d) => d.id)).toEqual(['d1', 'd2'])
    expect((await store.activeTo('dep', 'acme', 500)).map((d) => d.id)).toEqual(['d1'])
    expect((await store.activeFrom('boss', 'acme', 100)).map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(await store.activeTo('dep', 'acme', 100)).toContainEqual({
      id: 'd1', fromUserId: 'boss', toUserId: 'dep', permissions: ['p:*'], scope: 'acme', createdAt: 1,
    })

    expect(await store.pruneExpired(1_000)).toBe(1) // d2 only; open-ended ones stay
    await store.revoke('d1')
    expect((await store.all()).map((d) => d.id)).toEqual(['d3'])
  })

  it('refuses malformed records', async () => {
    const store = new PrismaDelegationStore(fakeClient().client)
    const ok = { id: 'd', fromUserId: 'a', toUserId: 'b', permissions: ['x:y'], scope: 's', createdAt: 1 }
    for (const bad of [{ ...ok, fromUserId: '' }, { ...ok, toUserId: null }, { ...ok, createdAt: Number.NaN }, { ...ok, expiresAt: 'soon' }]) {
      await expect(store.add(bad as never), JSON.stringify(bad)).rejects.toBeInstanceOf(TypeError)
    }
  })
})

describe('FA-H07 · wired through prismaAccessStore()', () => {
  it('exposes both stores, and the Gate honours them end to end', async () => {
    const { client } = fakeClient()
    const p = prismaAccessStore(client)
    expect(p.temporaryGrants).toBeInstanceOf(PrismaTemporaryGrantStore)
    expect(p.delegations).toBeInstanceOf(PrismaDelegationStore)

    let t = 1_000
    const gate = new Gate({ store: p.store, temporaryGrants: p.temporaryGrants, delegations: p.delegations, scope: () => GLOBAL_SCOPE, now: () => t })
    await gate.grantTemporarily('u1', ['reports:read'], { ttlMs: 500 })
    expect(await gate.can({ id: 'u1' }, 'reports:read')).toBe(true)
    t = 1_500
    expect(await gate.can({ id: 'u1' }, 'reports:read')).toBe(false)

    await gate.grantTemporarily('boss', ['invoices:*'], { ttlMs: 10_000 })
    await gate.delegate({ from: 'boss', to: 'dep', permissions: ['invoices:approve'] })
    expect(await gate.can({ id: 'dep' }, 'invoices:approve')).toBe(true)
    expect(await gate.can({ id: 'dep' }, 'invoices:void')).toBe(false)
  })

  it('does not require the new models until they are used — and then names the missing one', async () => {
    const { client } = fakeClient()
    // A client generated before the models existed.
    const { permTemporaryGrant: _t, permDelegation: _d, ...legacy } = client
    const p = prismaAccessStore(legacy)
    await expect(p.temporaryGrants.activeFor('u', 's', 0)).rejects.toThrow(/permTemporaryGrant/)
    await expect(p.delegations.activeTo('u', 's', 0)).rejects.toThrow(/permDelegation/)
  })
})
