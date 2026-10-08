import { describe, expect, it } from 'vitest'
import { syncConnection } from '../src/sync.js'
import {
  MemoryDriveConnectionStore,
  type DriveConnection,
  type DriveConnectionListFilter,
  type DriveConnectionPatch,
  type DriveConnectionStore,
} from '../src/store.js'
import { connect, harness } from './helpers.js'

const HEALTH_KEYS = ['lastSucceededAt', 'lastFailedAt', 'lastErrorCode'] as const

/**
 * A durable store written before the health fields existed: it maps the patch
 * straight onto its columns, so an unknown key throws — exactly what Prisma's
 * "Unknown argument" does for a missing column. It does not declare
 * `persistsHealth`, so the engine must never send it those keys.
 */
class LegacyStore implements DriveConnectionStore {
  readonly inner = new MemoryDriveConnectionStore()
  readonly patches: DriveConnectionPatch[] = []
  create(record: DriveConnection) {
    return this.inner.create(record)
  }
  find(tenantId: string, id: string) {
    return this.inner.find(tenantId, id)
  }
  list(tenantId: string, filter?: DriveConnectionListFilter) {
    return this.inner.list(tenantId, filter)
  }
  update(tenantId: string, id: string, patch: DriveConnectionPatch, expectedRevision?: number) {
    this.patches.push(patch)
    const unknown = HEALTH_KEYS.filter((key) => key in patch)
    if (unknown.length > 0) throw new Error(`Unknown argument \`${unknown[0]}\``)
    return this.inner.update(tenantId, id, patch, expectedRevision)
  }
  delete(tenantId: string, id: string) {
    return this.inner.delete(tenantId, id)
  }
}

const PAST_EXPIRY = 2 * 60 * 60_000
const FILES = { files: [{ externalId: 'f1', name: 'a.txt', content: 'x' }] }

describe('connection health with a store that does not declare persistsHealth', () => {
  it('check() answers without writing', async () => {
    const legacy = new LegacyStore()
    const h = harness({ drives: { store: legacy } })
    const view = await connect(h, { tenantId: 'acme' })
    const before = legacy.patches.length
    expect(await h.drives.check(view.id, { tenantId: 'acme' })).toEqual({ ok: true })
    h.fake.rateLimitNextCalls = 10
    expect(await h.drives.check(view.id, { tenantId: 'acme' })).toEqual({ ok: false, code: 'DRIVE_RATE_LIMITED' })
    expect(legacy.patches.length).toBe(before)
  })

  it('a sync persists its cursor and lastSyncedAt; a failed sync writes nothing', async () => {
    const legacy = new LegacyStore()
    const h = harness({ drives: { store: legacy }, provider: FILES })
    const view = await connect(h, { tenantId: 'acme' })
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })
    const synced = (await legacy.inner.find('acme', view.id))!
    expect(synced.lastSyncedAt).toBe(h.now())
    expect(synced.lastSucceededAt).toBeUndefined()

    h.fake.rateLimitNextCalls = 10
    const before = legacy.patches.length
    const failure = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'DRIVE_RATE_LIMITED' })
    expect(legacy.patches.length).toBe(before)
  })

  it('a dead grant is still marked invalid', async () => {
    const legacy = new LegacyStore()
    const h = harness({ drives: { store: legacy } })
    const view = await connect(h, { tenantId: 'acme' })
    h.advance(PAST_EXPIRY)
    h.fake.grantRevoked = true
    await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow()
    const stored = (await legacy.inner.find('acme', view.id))!
    expect(stored.status).toBe('invalid')
    expect(stored.lastErrorCode).toBeUndefined()
  })

  it('no patch the engine sent carried a health key', async () => {
    const legacy = new LegacyStore()
    const h = harness({ drives: { store: legacy }, provider: FILES })
    const view = await connect(h, { tenantId: 'acme' })
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })
    await h.drives.check(view.id, { tenantId: 'acme' })
    expect(legacy.patches.length).toBeGreaterThan(0)
    for (const patch of legacy.patches) for (const key of HEALTH_KEYS) expect(patch).not.toHaveProperty(key)
  })
})
