import { describe, expect, it, vi } from 'vitest'
import { DriveCredentials } from '../src/credentials.js'
import { DriveCredentialsInvalidError } from '../src/errors.js'
import { importItem } from '../src/import.js'
import { DriveSecretBox } from '../src/secret-box.js'
import { MemoryDriveConnectionStore, type DriveConnection } from '../src/store.js'
import { connect, harness, recordingSink, TEST_KEYS } from './helpers.js'

const PAST_EXPIRY = 61 * 60_000

describe('Drives.getItem', () => {
  it('returns an item’s metadata', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    expect(await h.drives.getItem(view.id, 'f1', { tenantId: 'acme' })).toMatchObject({ externalId: 'f1' })
  })

  it('returns null for an item that no longer exists', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    expect(await h.drives.getItem(view.id, 'gone', { tenantId: 'acme' })).toBeNull()
  })

  it('reports DRIVE_UNSUPPORTED when the adapter has no get', async () => {
    const h = harness()
    ;(h.fake as unknown as Record<string, unknown>)['get'] = undefined
    const view = await connect(h, { tenantId: 'acme' })
    await expect(h.drives.getItem(view.id, 'f1', { tenantId: 'acme' })).rejects.toMatchObject({
      code: 'DRIVE_UNSUPPORTED',
    })
  })
})

describe('Drives.forgetImports', () => {
  it('drops a connection’s ledger so a later sync re-imports', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    const { sink, seen } = recordingSink()
    const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!
    await importItem(h.drives, view.id, item, sink, { tenantId: 'acme' })

    expect(await h.drives.forgetImports(view.id, 'acme')).toBe(1)
    const again = await importItem(h.drives, view.id, item, sink, { tenantId: 'acme' })
    expect(again.status).toBe('imported')
    expect(seen).toHaveLength(2)
  })

  it('does not touch another tenant’s ledger', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const acme = await connect(h, { tenantId: 'acme' })
    const { sink } = recordingSink()
    const item = (await h.drives.listItems(acme.id, { tenantId: 'acme' })).items[0]!
    await importItem(h.drives, acme.id, item, sink, { tenantId: 'acme' })

    expect(await h.drives.forgetImports(acme.id, 'globex')).toBe(0)
    expect(await h.ledger.find('acme', acme.id, 'f1')).not.toBeNull()
  })
})

describe('disconnect with a live subscription', () => {
  it('unsubscribes at the provider before deleting the row', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    const { watchConnection } = await import('../src/notifications.js')
    const watch = await watchConnection(h.drives, view.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/notify',
    })
    expect(h.fake.watches.has(watch.id)).toBe(true)

    await h.drives.disconnect(view.id, { tenantId: 'acme' })
    expect(h.fake.watches.has(watch.id)).toBe(false)
    expect(await h.store.find('acme', view.id)).toBeNull()
  })

  it('still deletes the row when unsubscribing fails', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    const { watchConnection } = await import('../src/notifications.js')
    await watchConnection(h.drives, view.id, { tenantId: 'acme', notificationUrl: 'https://app.test/notify' })
    ;(h.fake as unknown as Record<string, unknown>)['unwatch'] = async () => {
      throw new Error('provider is down')
    }

    // A dangling subscription at the provider is noise; a row we cannot delete
    // is a bug.
    await h.drives.disconnect(view.id, { tenantId: 'acme' })
    expect(await h.store.find('acme', view.id)).toBeNull()
  })
})

describe('DriveCredentials — compare-and-set exhaustion', () => {
  /** A store that always loses the CAS, to drive the bounded-retry path. */
  class AlwaysLosingStore extends MemoryDriveConnectionStore {
    override async update(
      tenantId: string,
      id: string,
      patch: Parameters<MemoryDriveConnectionStore['update']>[2],
      expectedRevision?: number,
    ): Promise<DriveConnection | null> {
      if (expectedRevision !== undefined) return null
      return super.update(tenantId, id, patch, expectedRevision)
    }
  }

  const buildConnection = (box: DriveSecretBox, now: number): DriveConnection => {
    const context = { tenantId: 'acme', connectionId: 'c1', provider: 'fake' }
    return {
      id: 'c1',
      tenantId: 'acme',
      provider: 'fake',
      label: 'Stuck',
      status: 'active',
      // Already expired, so every `use` wants a refresh.
      secret: box.seal(JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: now - 1, storedAt: now }), context),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
  }

  it('gives up after a bounded number of collisions instead of livelocking', async () => {
    const box = new DriveSecretBox(TEST_KEYS)
    const store = new AlwaysLosingStore()
    const now = Date.now()
    const connection = buildConnection(box, now)
    await store.create(connection)

    const refresh = vi.fn(async () => ({ accessToken: 'fresh', refreshToken: 'r2', expiresAt: now - 1 }))
    const credentials = new DriveCredentials({
      store,
      box,
      fetchFor: () => async () => {
        throw new Error('unused')
      },
    })

    await expect(
      credentials.use(connection, { authorizeUrl: () => '', exchange: async () => ({ accessToken: '' }), refresh }),
    ).rejects.toThrow(DriveCredentialsInvalidError)
    // Bounded: a livelock against a token endpoint is an outage with someone
    // else's name on it.
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('fails closed when the connection vanished mid-refresh', async () => {
    const box = new DriveSecretBox(TEST_KEYS)
    const store = new AlwaysLosingStore()
    const now = Date.now()
    const connection = buildConnection(box, now)
    await store.create(connection)

    const credentials = new DriveCredentials({
      store,
      box,
      fetchFor: () => async () => {
        throw new Error('unused')
      },
    })
    const refresh = async () => {
      await store.delete('acme', 'c1')
      return { accessToken: 'fresh', expiresAt: now + 60_000 }
    }

    await expect(
      credentials.use(connection, { authorizeUrl: () => '', exchange: async () => ({ accessToken: '' }), refresh }),
    ).rejects.toThrow(/invalidated during a refresh/)
  })
})

describe('DriveCredentials.refreshNow', () => {
  it('refreshes even when the stored token has not expired yet', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    // What a caller does after a surprise 401 on a token we believed was good.
    const stored = (await h.store.find('acme', view.id))!
    const box = new DriveSecretBox(TEST_KEYS)
    const credentials = new DriveCredentials({
      store: h.store,
      box,
      fetchFor: () => async () => {
        throw new Error('unused')
      },
      now: h.now,
    })

    const result = await credentials.refreshNow(stored, h.fake.authorization)
    expect(result.accessToken).toBeTruthy()
    expect(h.fake.calls['refresh']).toBe(1)
  })
})

describe('secret rotation across a live connection', () => {
  it('still reads a connection sealed before the key ring rotated', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })

    // A new active key is prepended; the old one stays readable.
    const { Drives } = await import('../src/drives.js')
    const rotated = new Drives({
      providers: [h.fake],
      keys: [{ id: 'k2', key: 'n'.repeat(32) }, ...TEST_KEYS],
      secret: 'test-app-secret-value',
      store: h.store,
      now: h.now,
      retry: { attempts: 1 },
    })

    await expect(rotated.listItems(view.id, { tenantId: 'acme' })).resolves.toBeDefined()

    // And a refresh re-seals under the new active key.
    h.advance(PAST_EXPIRY)
    await rotated.listItems(view.id, { tenantId: 'acme' })
    expect((await h.store.find('acme', view.id))?.secret).toMatch(/^bkd1\.k2\./)
  })

  it('cannot read a connection once its key is dropped from the ring', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    const { Drives } = await import('../src/drives.js')
    const wrongRing = new Drives({
      providers: [h.fake],
      keys: [{ id: 'k2', key: 'n'.repeat(32) }],
      secret: 'test-app-secret-value',
      store: h.store,
      now: h.now,
      retry: { attempts: 1 },
    })

    await expect(wrongRing.listItems(view.id, { tenantId: 'acme' })).rejects.toMatchObject({
      code: 'DRIVE_SECRET_KEY_UNKNOWN',
    })
  })
})
