import { describe, expect, it } from 'vitest'
import { Drives } from '../src/drives.js'
import { DriveSecretKeyUnknownError, DriveTenantMismatchError } from '../src/errors.js'
import { DriveSecretBox } from '../src/secret-box.js'
import { MemoryDriveConnectionStore, type DriveConnection } from '../src/store.js'
import { FakeDriveProvider } from '../src/testing.js'
import { forbiddenTransport, TEST_SECRET } from './helpers.js'
import { runWithContext } from '@basaltkit/core'

const OLD = { id: 'k-old', key: 'o'.repeat(32) }
const NEW = { id: 'k-new', key: 'n'.repeat(32) }
const TOKENS = JSON.stringify({ accessToken: 'at', refreshToken: 'rt' })

function row(box: DriveSecretBox, tenantId: string, id: string): DriveConnection {
  return {
    id,
    tenantId,
    provider: 'fake',
    label: id,
    status: 'active',
    secret: box.seal(TOKENS, { tenantId, connectionId: id, provider: 'fake' }),
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function drivesWith(store: MemoryDriveConnectionStore, keys = [NEW, OLD]): Drives {
  return new Drives({ providers: [new FakeDriveProvider()], keys, secret: TEST_SECRET, store, transport: forbiddenTransport })
}

describe('Drives.rotateSecrets', () => {
  it('re-seals every row on a retired key, across the given tenants, and reports none left', async () => {
    const store = new MemoryDriveConnectionStore()
    const oldBox = new DriveSecretBox([OLD])
    await store.create(row(oldBox, 'acme', 'a1'))
    await store.create(row(oldBox, 'acme', 'a2'))
    await store.create(row(oldBox, 'globex', 'g1'))
    const drives = drivesWith(store)

    const result = await drives.rotateSecrets({ tenantIds: ['acme', 'globex'] })
    expect(result).toEqual({ resealed: 3, skippedConflicts: 0, remainingOnOldKeys: 0 })

    const box = new DriveSecretBox([NEW, OLD])
    for (const [tenantId, id] of [['acme', 'a1'], ['acme', 'a2'], ['globex', 'g1']] as const) {
      const stored = (await store.find(tenantId, id))!
      expect(box.keyIdOf(stored.secret)).toBe('k-new')
      expect(box.open(stored.secret, { tenantId, connectionId: id, provider: 'fake' })).toBe(TOKENS)
      expect(stored.revision).toBe(2)
    }
    // Dropping the old key now leaves everything readable.
    const onlyNew = new DriveSecretBox([NEW])
    const stored = (await store.find('acme', 'a1'))!
    expect(onlyNew.open(stored.secret, { tenantId: 'acme', connectionId: 'a1', provider: 'fake' })).toBe(TOKENS)
  })

  it('does not write a row already on the active key', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(row(new DriveSecretBox([NEW]), 'acme', 'a1'))
    const result = await drivesWith(store).rotateSecrets({ tenantIds: ['acme'] })
    expect(result).toEqual({ resealed: 0, skippedConflicts: 0, remainingOnOldKeys: 0 })
    expect((await store.find('acme', 'a1'))!.revision).toBe(1)
  })

  it('skips a row that changed under it (compare-and-set) instead of overwriting', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(row(new DriveSecretBox([OLD]), 'acme', 'a1'))
    // A concurrent writer bumps the revision between list() and update().
    const racing = Object.create(store) as MemoryDriveConnectionStore
    racing.list = async (tenantId) => {
      const rows = await store.list(tenantId)
      await store.update(tenantId, 'a1', { label: 'renamed by someone else' })
      return rows
    }
    const result = await drivesWith(racing).rotateSecrets({ tenantIds: ['acme'] })
    expect(result).toEqual({ resealed: 0, skippedConflicts: 1, remainingOnOldKeys: 1 })
    const stored = (await store.find('acme', 'a1'))!
    expect(stored.label).toBe('renamed by someone else')
    expect(new DriveSecretBox([OLD]).keyIdOf(stored.secret)).toBe('k-old')
  })

  it('throws a clear error for a secret sealed with a key no longer in the ring', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(row(new DriveSecretBox([OLD]), 'acme', 'a1'))
    await expect(drivesWith(store, [NEW]).rotateSecrets({ tenantIds: ['acme'] })).rejects.toThrow(
      DriveSecretKeyUnknownError,
    )
  })

  it('uses the single-tenant key when no tenant ids are given in a single-tenant app', async () => {
    const store = new MemoryDriveConnectionStore()
    await store.create(row(new DriveSecretBox([OLD]), '@single', 's1'))
    const result = await drivesWith(store).rotateSecrets()
    expect(result.resealed).toBe(1)
  })

  it('refuses to widen past the tenant in context', async () => {
    const store = new MemoryDriveConnectionStore()
    const drives = drivesWith(store)
    await expect(
      runWithContext({ tenant: { id: 'acme' } } as never, () => drives.rotateSecrets({ tenantIds: ['acme', 'globex'] })),
    ).rejects.toThrow(DriveTenantMismatchError)
  })
})
