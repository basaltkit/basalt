import { strict as assert } from 'node:assert'
import type { DriveConnection, DriveConnectionStore, DriveImportLedger, DriveImportRecord } from './store.js'

/**
 * A reusable conformance suite for a durable {@link DriveConnectionStore} and
 * {@link DriveImportLedger}.
 *
 * `@basaltkit/drives` ships only the in-memory stores: apps model their rows
 * differently (one table or two, a `tenantId` column or a schema per tenant),
 * so a single Prisma/SQL package would fit almost nobody. What every store
 * must share is the *behaviour* the engine relies on, and that is what this
 * suite pins down:
 *
 * - **compare-and-set** — `update(…, expectedRevision)` applies only when the
 *   stored revision matches and returns `null` otherwise. The refresh-race fix
 *   (FA-074) depends on it: a store that ignores the argument is not safe to
 *   run more than one worker against;
 * - every write bumps `revision`;
 * - a patch key present with `undefined` **clears** the column, an absent key
 *   leaves it alone;
 * - **tenant isolation** on `find`, `list`, `update` and `delete`;
 * - ledger writes are idempotent per `(tenantId, connectionId, externalId)`.
 *
 * It is runner-agnostic: pass your runner's `describe` and `it` (vitest, jest,
 * `node:test`); assertions are thrown as plain `AssertionError`s.
 *
 * ```ts
 * import { describe, it } from 'vitest'
 * import { runDriveStoreContract } from '@basaltkit/drives/testing'
 *
 * runDriveStoreContract(async () => {
 *   await db.driveConnection.deleteMany()
 *   await db.driveImport.deleteMany()
 *   return { store: new PrismaDriveConnectionStore(db), ledger: new PrismaDriveImportLedger(db) }
 * }, { describe, it })
 * ```
 *
 * The factory runs before **every** case and must return empty stores.
 */
export interface DriveStoreContractHarness {
  describe: (name: string, body: () => void) => unknown
  it: (name: string, body: () => Promise<void>) => unknown
}

export interface DriveStoreContractSubject {
  store: DriveConnectionStore
  ledger: DriveImportLedger
}

export function runDriveStoreContract(
  factory: () => Promise<DriveStoreContractSubject> | DriveStoreContractSubject,
  harness: DriveStoreContractHarness,
  options: { name?: string } = {},
): void {
  const { describe, it } = harness
  const row = (overrides: Partial<DriveConnection> = {}): DriveConnection => ({
    id: 'conn-1',
    tenantId: 'tenant-a',
    provider: 'google',
    label: 'Drive Finance',
    status: 'active',
    secret: 'bkd1.k1.iv.tag.ct',
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  })
  const imported = (overrides: Partial<DriveImportRecord> = {}): DriveImportRecord => ({
    tenantId: 'tenant-a',
    connectionId: 'conn-1',
    externalId: 'file-1',
    version: 'v1',
    targetId: 'target-1',
    strategy: 'copy',
    importedAt: 2_000,
    ...overrides,
  })

  describe(options.name ?? 'drive store contract', () => {
    describe('DriveConnectionStore', () => {
      it('round-trips a connection within its tenant', async () => {
        const { store } = await factory()
        await store.create(row({ cursor: 'c-1', rootId: 'root', scopes: ['a', 'b'], account: { email: 'x@y.z' } }))
        const found = await store.find('tenant-a', 'conn-1')
        assert.ok(found, 'find() must return the created row')
        assert.equal(found.tenantId, 'tenant-a')
        assert.equal(found.provider, 'google')
        assert.equal(found.label, 'Drive Finance')
        assert.equal(found.status, 'active')
        assert.equal(found.secret, 'bkd1.k1.iv.tag.ct')
        assert.equal(found.cursor, 'c-1')
        assert.equal(found.rootId, 'root')
        assert.deepEqual([...(found.scopes ?? [])], ['a', 'b'])
        assert.equal(found.account?.email, 'x@y.z')
        assert.equal(found.revision, 1)
      })

      it('does not find a row through another tenant', async () => {
        const { store } = await factory()
        await store.create(row())
        assert.equal(await store.find('tenant-b', 'conn-1'), null)
      })

      it('lists only the given tenant, honouring provider and status filters', async () => {
        const { store } = await factory()
        await store.create(row({ id: 'a1' }))
        await store.create(row({ id: 'a2', provider: 'dropbox', status: 'invalid', createdAt: 1_001 }))
        await store.create(row({ id: 'b1', tenantId: 'tenant-b' }))
        const all = await store.list('tenant-a')
        assert.deepEqual(all.map((r) => r.id).sort(), ['a1', 'a2'])
        assert.ok(all.every((r) => r.tenantId === 'tenant-a'))
        assert.deepEqual((await store.list('tenant-a', { provider: 'dropbox' })).map((r) => r.id), ['a2'])
        assert.deepEqual((await store.list('tenant-a', { status: 'active' })).map((r) => r.id), ['a1'])
        assert.deepEqual((await store.list('tenant-b')).map((r) => r.id), ['b1'])
      })

      it('bumps revision on every write', async () => {
        const { store } = await factory()
        await store.create(row())
        const first = await store.update('tenant-a', 'conn-1', { label: 'Renamed' })
        assert.ok(first)
        assert.equal(first.revision, 2)
        assert.equal(first.label, 'Renamed')
        const second = await store.update('tenant-a', 'conn-1', { status: 'invalid' })
        assert.equal(second?.revision, 3)
      })

      it('applies a write whose expectedRevision matches', async () => {
        const { store } = await factory()
        await store.create(row())
        const updated = await store.update('tenant-a', 'conn-1', { secret: 'bkd1.k2.iv.tag.ct' }, 1)
        assert.ok(updated, 'a matching expectedRevision must apply')
        assert.equal(updated.secret, 'bkd1.k2.iv.tag.ct')
        assert.equal(updated.revision, 2)
      })

      it('refuses a write whose expectedRevision is stale (compare-and-set)', async () => {
        const { store } = await factory()
        await store.create(row())
        await store.update('tenant-a', 'conn-1', { label: 'winner' })
        const loser = await store.update('tenant-a', 'conn-1', { label: 'loser', secret: 'stale' }, 1)
        assert.equal(loser, null, 'a stale expectedRevision must return null')
        const stored = await store.find('tenant-a', 'conn-1')
        assert.equal(stored?.label, 'winner', 'a refused write must change nothing')
        assert.equal(stored?.secret, 'bkd1.k1.iv.tag.ct')
        assert.equal(stored?.revision, 2)
      })

      it('clears a column for a key present with undefined and keeps an absent key', async () => {
        const { store } = await factory()
        await store.create(row({ cursor: 'c-1', rootId: 'root' }))
        const updated = await store.update('tenant-a', 'conn-1', { cursor: undefined })
        assert.ok(updated)
        assert.equal(updated.cursor, undefined, 'an explicitly undefined key must clear the column')
        assert.equal(updated.rootId, 'root', 'an absent key must leave the column alone')
        const reread = await store.find('tenant-a', 'conn-1')
        assert.equal(reread?.cursor, undefined)
        assert.equal(reread?.rootId, 'root')
      })

      it('persists health fields (lastSucceededAt, lastFailedAt, lastErrorCode)', async () => {
        const { store } = await factory()
        await store.create(row())
        await store.update('tenant-a', 'conn-1', { lastFailedAt: 5_000, lastErrorCode: 'DRIVE_CREDENTIALS_INVALID' })
        await store.update('tenant-a', 'conn-1', { lastSucceededAt: 6_000 })
        const found = await store.find('tenant-a', 'conn-1')
        assert.equal(found?.lastFailedAt, 5_000)
        assert.equal(found?.lastErrorCode, 'DRIVE_CREDENTIALS_INVALID')
        assert.equal(found?.lastSucceededAt, 6_000)
      })

      it('does not update a row through another tenant', async () => {
        const { store } = await factory()
        await store.create(row())
        assert.equal(await store.update('tenant-b', 'conn-1', { label: 'hijacked' }), null)
        assert.equal((await store.find('tenant-a', 'conn-1'))?.label, 'Drive Finance')
      })

      it('does not delete a row through another tenant', async () => {
        const { store } = await factory()
        await store.create(row())
        await store.delete('tenant-b', 'conn-1')
        assert.ok(await store.find('tenant-a', 'conn-1'), 'a delete scoped to another tenant must not remove the row')
        await store.delete('tenant-a', 'conn-1')
        assert.equal(await store.find('tenant-a', 'conn-1'), null)
      })

      it('returns null when updating a row that does not exist', async () => {
        const { store } = await factory()
        assert.equal(await store.update('tenant-a', 'missing', { label: 'x' }), null)
      })
    })

    describe('DriveImportLedger', () => {
      it('records and finds an import', async () => {
        const { ledger } = await factory()
        await ledger.record(imported())
        const found = await ledger.find('tenant-a', 'conn-1', 'file-1')
        assert.ok(found)
        assert.equal(found.version, 'v1')
        assert.equal(found.targetId, 'target-1')
        assert.equal(found.strategy, 'copy')
      })

      it('is idempotent per (tenantId, connectionId, externalId): the latest record wins', async () => {
        const { ledger } = await factory()
        await ledger.record(imported())
        await ledger.record(imported({ version: 'v2', targetId: 'target-2' }))
        const rows = await ledger.list('tenant-a', 'conn-1')
        assert.equal(rows.length, 1, 'recording the same key twice must not create a second row')
        assert.equal(rows[0]?.version, 'v2')
      })

      it('isolates tenants and connections', async () => {
        const { ledger } = await factory()
        await ledger.record(imported())
        await ledger.record(imported({ connectionId: 'conn-2' }))
        await ledger.record(imported({ tenantId: 'tenant-b' }))
        assert.equal(await ledger.find('tenant-b', 'conn-2', 'file-1'), null)
        assert.equal((await ledger.list('tenant-a', 'conn-1')).length, 1)
        assert.equal((await ledger.list('tenant-a', 'conn-2')).length, 1)
        assert.ok((await ledger.list('tenant-b', 'conn-1')).every((r) => r.tenantId === 'tenant-b'))
      })

      it('forgets only the addressed record', async () => {
        const { ledger } = await factory()
        await ledger.record(imported())
        await ledger.record(imported({ tenantId: 'tenant-b' }))
        await ledger.forget('tenant-a', 'conn-1', 'file-1')
        assert.equal(await ledger.find('tenant-a', 'conn-1', 'file-1'), null)
        assert.ok(await ledger.find('tenant-b', 'conn-1', 'file-1'))
      })
    })
  })
}
