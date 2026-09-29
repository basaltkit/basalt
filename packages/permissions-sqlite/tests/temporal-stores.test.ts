import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Gate, GLOBAL_SCOPE } from '@basaltkit/permissions'
import {
  openPermissionsDatabase,
  SqliteDelegationStore,
  SqliteTemporaryGrantStore,
  sqliteAccessStore,
} from '../src/index.js'

/**
 * FA-H07 · durable TemporaryGrantStore / DelegationStore. Only the in-memory
 * stores existed, so a time-boxed grant or a delegation vanished on restart.
 */
describe('FA-H07 · SqliteTemporaryGrantStore', () => {
  it('returns a grant only while live, for its user and scope', async () => {
    const store = new SqliteTemporaryGrantStore(openPermissionsDatabase())
    await store.add({ id: 'g1', userId: 'u1', permissions: ['reports:read'], scope: 'acme', expiresAt: 2_000, grantedBy: 'admin' })
    await store.add({ id: 'g2', userId: 'u1', permissions: ['x:y'], scope: 'globex', expiresAt: 2_000 })

    expect(await store.activeFor('u1', 'acme', 1_000)).toEqual([
      { id: 'g1', userId: 'u1', permissions: ['reports:read'], scope: 'acme', expiresAt: 2_000, grantedBy: 'admin' },
    ])
    expect(await store.activeFor('u1', 'acme', 2_000)).toEqual([]) // expiry is exclusive
    expect(await store.activeFor('u2', 'acme', 1_000)).toEqual([])

    await store.add({ id: 'g1', userId: 'u1', permissions: ['reports:*'], scope: 'acme', expiresAt: 3_000 }) // same id replaces
    expect((await store.activeFor('u1', 'acme', 2_500)).map((g) => g.permissions)).toEqual([['reports:*']])

    await store.revoke('g1')
    expect((await store.all()).map((g) => g.id)).toEqual(['g2'])
    expect(await store.pruneExpired(2_000)).toBe(1)
    expect(await store.all()).toEqual([])
  })

  it('refuses malformed records instead of persisting them', async () => {
    const store = new SqliteTemporaryGrantStore(openPermissionsDatabase())
    const ok = { id: 'g', userId: 'u', permissions: ['a:b'], scope: 's', expiresAt: 1_000 }
    for (const bad of [
      { ...ok, id: '' },
      { ...ok, userId: null },
      { ...ok, scope: undefined },
      { ...ok, permissions: 'a:b' },
      { ...ok, expiresAt: Number.POSITIVE_INFINITY },
      { ...ok, grantedBy: 1 },
    ]) {
      await expect(store.add(bad as never), JSON.stringify(bad)).rejects.toBeInstanceOf(TypeError)
    }
    expect(await store.all()).toEqual([])
  })
})

describe('FA-H07 · SqliteDelegationStore', () => {
  it('returns open-ended and unexpired delegations, by direction and scope', async () => {
    const store = new SqliteDelegationStore(openPermissionsDatabase())
    await store.add({ id: 'd1', fromUserId: 'boss', toUserId: 'dep', permissions: ['p:*'], scope: 'acme', createdAt: 1 })
    await store.add({ id: 'd2', fromUserId: 'boss', toUserId: 'dep', permissions: ['q:r'], scope: 'acme', createdAt: 1, expiresAt: 500 })
    await store.add({ id: 'd3', fromUserId: 'boss', toUserId: 'dep', permissions: ['z:z'], scope: 'globex', createdAt: 1 })

    expect((await store.activeTo('dep', 'acme', 100)).map((d) => d.id)).toEqual(['d1', 'd2'])
    expect((await store.activeTo('dep', 'acme', 500)).map((d) => d.id)).toEqual(['d1'])
    expect((await store.activeFrom('boss', 'acme', 100)).map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(await store.activeFrom('dep', 'acme', 100)).toEqual([])
    expect((await store.activeTo('dep', 'acme', 100))[0]).toEqual({
      id: 'd1', fromUserId: 'boss', toUserId: 'dep', permissions: ['p:*'], scope: 'acme', createdAt: 1,
    })

    expect(await store.pruneExpired(1_000)).toBe(1) // d2 only; open-ended ones stay
    await store.revoke('d1')
    expect((await store.all()).map((d) => d.id)).toEqual(['d3'])
  })

  it('refuses malformed records', async () => {
    const store = new SqliteDelegationStore(openPermissionsDatabase())
    const ok = { id: 'd', fromUserId: 'a', toUserId: 'b', permissions: ['x:y'], scope: 's', createdAt: 1 }
    for (const bad of [{ ...ok, fromUserId: '' }, { ...ok, toUserId: 7 }, { ...ok, createdAt: Number.NaN }, { ...ok, expiresAt: 'soon' }]) {
      await expect(store.add(bad as never), JSON.stringify(bad)).rejects.toBeInstanceOf(TypeError)
    }
  })
})

describe('FA-H07 · wired through sqliteAccessStore()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basalt-perm-temporal-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('the Gate honours both stores, and they survive a restart', async () => {
    const file = join(dir, 'perm.db')
    let t = 1_000
    const first = sqliteAccessStore(file)
    const gate = new Gate({ ...first, scope: () => GLOBAL_SCOPE, now: () => t })
    await gate.grantTemporarily('u1', ['reports:read'], { ttlMs: 500 })
    await gate.grantToUser('boss', ['invoices:*'])
    await gate.delegate({ from: 'boss', to: 'dep', permissions: ['invoices:approve'] })
    first.db.close()

    const second = sqliteAccessStore(file)
    expect(second.temporaryGrants).toBeInstanceOf(SqliteTemporaryGrantStore)
    const reopened = new Gate({ ...second, scope: () => GLOBAL_SCOPE, now: () => t })
    expect(await reopened.can({ id: 'u1' }, 'reports:read')).toBe(true)
    expect(await reopened.can({ id: 'dep' }, 'invoices:approve')).toBe(true)
    expect(await reopened.can({ id: 'dep' }, 'invoices:void')).toBe(false)
    t = 1_500
    expect(await reopened.can({ id: 'u1' }, 'reports:read')).toBe(false)
    second.db.close()
  })
})
