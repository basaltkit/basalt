import { describe, expect, it } from 'vitest'
import {
  MemoryDriveConnectionStore,
  MemoryDriveImportLedger,
  type DriveConnection,
} from '../src/store.js'

const connection = (overrides: Partial<DriveConnection> = {}): DriveConnection => ({
  id: 'c1',
  tenantId: 'acme',
  provider: 'fake',
  label: 'Drive Finance',
  status: 'active',
  secret: 'bkd1.k1.a.b.c',
  revision: 1,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
})

describe('MemoryDriveConnectionStore', () => {
  it('finds only within the given tenant', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(connection())
    expect(await store.find('acme', 'c1')).not.toBeNull()
    expect(await store.find('globex', 'c1')).toBeNull()
  })

  it('does not let a separator in a tenant id address another tenant’s row', async () => {
    // Why the key is a JSON tuple and not a joined string.
    const store = new MemoryDriveConnectionStore()
    await store.create(connection({ tenantId: 'a', id: 'b:c' }))
    expect(await store.find('a:b', 'c')).toBeNull()
  })

  it('returns copies, so a caller cannot mutate the stored record', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(connection())
    const found = (await store.find('acme', 'c1'))!
    found.label = 'mutated'
    expect((await store.find('acme', 'c1'))?.label).toBe('Drive Finance')
  })

  it('lists by tenant, filtered and ordered', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(connection({ id: 'c1', createdAt: 2000, label: 'second' }))
    await store.create(connection({ id: 'c2', createdAt: 1000, label: 'first' }))
    await store.create(connection({ id: 'c3', provider: 'other', label: 'other provider' }))
    await store.create(connection({ id: 'c4', tenantId: 'globex', label: 'elsewhere' }))

    expect((await store.list('acme')).map((c) => c.label)).toEqual(['first', 'other provider', 'second'])
    expect((await store.list('acme', { provider: 'fake' })).map((c) => c.label)).toEqual(['first', 'second'])
    expect((await store.list('globex')).map((c) => c.label)).toEqual(['elsewhere'])
  })

  it('filters a listing by status', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(connection({ id: 'c1' }))
    await store.create(connection({ id: 'c2', status: 'invalid' }))
    expect((await store.list('acme', { status: 'invalid' })).map((c) => c.id)).toEqual(['c2'])
  })

  describe('update', () => {
    it('applies a patch and bumps the revision', async () => {
      const store = new MemoryDriveConnectionStore()
      await store.create(connection())
      const updated = await store.update('acme', 'c1', { label: 'renamed' })
      expect(updated?.label).toBe('renamed')
      expect(updated?.revision).toBe(2)
    })

    it('clears a field when the patch carries an explicit undefined', async () => {
      // The documented contract: present-with-undefined clears, absent leaves.
      const store = new MemoryDriveConnectionStore()
      await store.create(connection({ cursor: 'abc' }))
      const updated = await store.update('acme', 'c1', { cursor: undefined })
      expect(updated?.cursor).toBeUndefined()
    })

    it('leaves a field alone when the key is absent', async () => {
      const store = new MemoryDriveConnectionStore()
      await store.create(connection({ cursor: 'abc' }))
      const updated = await store.update('acme', 'c1', { label: 'renamed' })
      expect(updated?.cursor).toBe('abc')
    })

    it('returns null for another tenant’s row', async () => {
      const store = new MemoryDriveConnectionStore()
      await store.create(connection())
      expect(await store.update('globex', 'c1', { label: 'hijacked' })).toBeNull()
      expect((await store.find('acme', 'c1'))?.label).toBe('Drive Finance')
    })

    it('returns null for a missing row', async () => {
      const store = new MemoryDriveConnectionStore()
      expect(await store.update('acme', 'nope', { label: 'x' })).toBeNull()
    })

    describe('optimistic concurrency', () => {
      it('applies the write when the revision still matches', async () => {
        const store = new MemoryDriveConnectionStore()
        await store.create(connection())
        expect(await store.update('acme', 'c1', { label: 'ok' }, 1)).not.toBeNull()
      })

      it('writes NOTHING when the revision moved on', async () => {
        const store = new MemoryDriveConnectionStore()
        await store.create(connection())
        await store.update('acme', 'c1', { label: 'winner' })

        expect(await store.update('acme', 'c1', { label: 'loser' }, 1)).toBeNull()
        expect((await store.find('acme', 'c1'))?.label).toBe('winner')
      })
    })
  })

  it('deletes only within the tenant', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(connection())
    await store.delete('globex', 'c1')
    expect(await store.find('acme', 'c1')).not.toBeNull()
    await store.delete('acme', 'c1')
    expect(await store.find('acme', 'c1')).toBeNull()
  })
})

describe('MemoryDriveImportLedger', () => {
  const record = (overrides: Partial<import('../src/store.js').DriveImportRecord> = {}) => ({
    tenantId: 'acme',
    connectionId: 'c1',
    externalId: 'f1',
    version: 'v:r1',
    targetId: 't1',
    strategy: 'copy' as const,
    importedAt: 1000,
    ...overrides,
  })

  it('records and finds by the full composite key', async () => {
    const ledger = new MemoryDriveImportLedger()
    await ledger.record(record())
    expect(await ledger.find('acme', 'c1', 'f1')).toMatchObject({ targetId: 't1' })
  })

  it('is keyed per tenant AND per connection', async () => {
    const ledger = new MemoryDriveImportLedger()
    await ledger.record(record())
    expect(await ledger.find('globex', 'c1', 'f1')).toBeNull()
    expect(await ledger.find('acme', 'c2', 'f1')).toBeNull()
  })

  it('overwrites the entry for the same key on re-import', async () => {
    const ledger = new MemoryDriveImportLedger()
    await ledger.record(record())
    await ledger.record(record({ version: 'v:r2', targetId: 't2' }))
    expect(await ledger.find('acme', 'c1', 'f1')).toMatchObject({ version: 'v:r2', targetId: 't2' })
  })

  it('forgets one entry', async () => {
    const ledger = new MemoryDriveImportLedger()
    await ledger.record(record())
    await ledger.forget('acme', 'c1', 'f1')
    expect(await ledger.find('acme', 'c1', 'f1')).toBeNull()
  })

  it('lists one connection’s imports only', async () => {
    const ledger = new MemoryDriveImportLedger()
    await ledger.record(record({ externalId: 'f1' }))
    await ledger.record(record({ externalId: 'f2' }))
    await ledger.record(record({ connectionId: 'c2', externalId: 'f3' }))
    await ledger.record(record({ tenantId: 'globex', externalId: 'f4' }))

    expect((await ledger.list('acme', 'c1')).map((r) => r.externalId).sort()).toEqual(['f1', 'f2'])
  })

  it('returns copies', async () => {
    const ledger = new MemoryDriveImportLedger()
    await ledger.record(record())
    const found = (await ledger.find('acme', 'c1', 'f1'))!
    found.targetId = 'mutated'
    expect((await ledger.find('acme', 'c1', 'f1'))?.targetId).toBe('t1')
  })
})
