import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import {
  Disk,
  LocalStorageDriver,
  STORAGE,
  storagePlugin,
  StorageInvalidScopeError,
  StorageTenantRequiredError,
  TemporaryUrlTtlTooLongError,
  type StorageDriver,
} from '../src/index.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-storage-sec-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const as = <T>(id: string, fn: () => Promise<T>) => runWithContext({ tenant: { id } }, fn)

/** Stand-in for @basaltkit/tenancy: only the metadata marker matters. */
const fakeTenancy = definePlugin({
  name: 'test:tenancy-marker',
  register({ container }) {
    ensureMetadata(container).add('tenancy:active', true)
  },
})

/** In-memory driver that supports temporaryUrl, to test the Disk-level cap. */
class SigningDriver implements StorageDriver {
  readonly name = 'signing'
  readonly files = new Map<string, Buffer>()
  lastTtl: number | undefined
  async put(path: string, content: Buffer | string) {
    this.files.set(path, Buffer.from(content))
  }
  async get(path: string) {
    return this.files.get(path) ?? Buffer.alloc(0)
  }
  async exists(path: string) {
    return this.files.has(path)
  }
  async delete(path: string) {
    return this.files.delete(path)
  }
  async list(prefix: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix))
  }
  async temporaryUrl(path: string, expiresInMs: number) {
    this.lastTtl = expiresInMs
    return `https://signed.test/${path}?ttl=${expiresInMs}`
  }
  async disconnect() {}
}

describe('security: the tenant scope segment cannot escape tenants/<id>', () => {
  it('refuses tenant ids containing "/", "..", "\\\\", or control characters', async () => {
    const disk = new Disk('uploads', new LocalStorageDriver({ root }))
    await as('globex', () => disk.put('files/secret.txt', 'GLOBEX SECRET'))
    await disk.put('central.txt', 'CENTRAL') // no tenant, standalone disk

    for (const id of ['..', '.', 'globex/files', 'globex\\files', 'a\u0000', 'a\n', '../globex']) {
      await expect(as(id, () => disk.get('secret.txt')), JSON.stringify(id)).rejects.toBeInstanceOf(StorageInvalidScopeError)
      await expect(as(id, () => disk.list('')), JSON.stringify(id)).rejects.toBeInstanceOf(StorageInvalidScopeError)
      await expect(as(id, () => disk.put('x.txt', 'poison')), JSON.stringify(id)).rejects.toBeInstanceOf(StorageInvalidScopeError)
    }
    // tenant '..' used to collapse onto the bucket root and read central files
    await expect(as('..', () => disk.get('central.txt'))).rejects.toBeInstanceOf(StorageInvalidScopeError)
  })
})

describe('security: a tenant-scoped disk fails closed when tenancy is active but no tenant resolved', () => {
  const boot = (disks: Parameters<typeof storagePlugin>[0]['disks'], withTenancy = true) =>
    createApp({ plugins: [...(withTenancy ? [fakeTenancy] : []), storagePlugin({ disks })] }).boot()

  it('refuses every operation without a ctx tenant instead of using the bucket root', async () => {
    const app = await boot({ uploads: { driver: 'local', root } })
    const disk = app.container.get(STORAGE).disk('uploads')
    await as('victim', () => disk.put('contracts/secret.txt', 'VICTIM-CONFIDENTIAL'))

    await runWithContext({}, async () => {
      await expect(disk.get('tenants/victim/contracts/secret.txt')).rejects.toBeInstanceOf(StorageTenantRequiredError)
      await expect(disk.list('tenants')).rejects.toBeInstanceOf(StorageTenantRequiredError)
      await expect(disk.list()).rejects.toBeInstanceOf(StorageTenantRequiredError)
      await expect(disk.exists('tenants/victim/contracts/secret.txt')).rejects.toBeInstanceOf(StorageTenantRequiredError)
      await expect(disk.put('tenants/victim/contracts/secret.txt', 'x')).rejects.toBeInstanceOf(StorageTenantRequiredError)
      await expect(disk.delete('tenants/victim/contracts/secret.txt')).rejects.toBeInstanceOf(StorageTenantRequiredError)
    })
    // outside any context at all, too
    await expect(disk.get('tenants/victim/contracts/secret.txt')).rejects.toMatchObject({
      code: 'STORAGE_TENANT_REQUIRED',
      status: 400,
    })
    // and the victim's file is intact, readable in its own scope
    expect((await as('victim', () => disk.get('contracts/secret.txt'))).toString()).toBe('VICTIM-CONFIDENTIAL')
  })

  it('temporaryUrl fails closed too', async () => {
    const driver = new SigningDriver()
    const app = await boot({ s: { driver } })
    const disk = app.container.get(STORAGE).disk('s')
    await expect(disk.temporaryUrl('tenants/victim/a.pdf', '5m')).rejects.toBeInstanceOf(StorageTenantRequiredError)
  })

  it("explicit opt-outs keep central disks working: scope:null and onMissingScope:'root'", async () => {
    const app = await boot({
      central: { driver: 'local', root: join(root, 'central'), scope: null },
      mixed: { driver: 'local', root: join(root, 'mixed'), onMissingScope: 'root' },
    })
    const storage = app.container.get(STORAGE)
    await storage.disk('central').put('backup.tar', 'b')
    expect((await storage.disk('central').get('backup.tar')).toString()).toBe('b')
    await storage.disk('mixed').put('branding.css', 'c')
    expect((await storage.disk('mixed').get('branding.css')).toString()).toBe('c')
  })

  it('does not depend on plugin order: STORAGE resolved before tenancy registers still fails closed', async () => {
    // A plugin that resolves the disk eagerly in its own register(), listed
    // before tenancy: the tenancy marker is not there yet at that moment, but
    // the app IS multi-tenant by the time any request runs.
    let early: Disk | undefined
    const eager = definePlugin({
      name: 'test:eager-storage-consumer',
      register({ container }) {
        early = container.get(STORAGE).disk('uploads')
      },
    })
    const app = await createApp({
      plugins: [storagePlugin({ disks: { uploads: { driver: 'local', root } } }), eager, fakeTenancy],
    }).boot()
    const disk = app.container.get(STORAGE).disk('uploads')
    expect(disk).toBe(early)
    await as('victim', () => disk.put('contracts/secret.txt', 'VICTIM-CONFIDENTIAL'))
    await expect(disk.get('tenants/victim/contracts/secret.txt')).rejects.toBeInstanceOf(StorageTenantRequiredError)
    await expect(disk.list('tenants')).rejects.toBeInstanceOf(StorageTenantRequiredError)
  })

  it('single-tenant apps (no tenancy registered) are unchanged', async () => {
    const app = await boot({ uploads: { driver: 'local', root } }, false)
    const disk = app.container.get(STORAGE).disk('uploads')
    await disk.put('a.txt', 'x')
    expect((await disk.get('a.txt')).toString()).toBe('x')
  })
})

describe('security: temporary URL lifetimes are capped', () => {
  it('rejects an expiresIn above the default 7-day maximum with a 400', async () => {
    const driver = new SigningDriver()
    const disk = new Disk('s', driver, { scope: null })
    await expect(disk.temporaryUrl('r.pdf', '36500d')).rejects.toBeInstanceOf(TemporaryUrlTtlTooLongError)
    await expect(disk.temporaryUrl('r.pdf', '8d')).rejects.toMatchObject({ code: 'STORAGE_TEMPORARY_URL_TTL', status: 400 })
    expect(driver.lastTtl).toBeUndefined()
    await expect(disk.temporaryUrl('r.pdf', '7d')).resolves.toContain('signed.test/r.pdf')
    await expect(disk.temporaryUrl('r.pdf', '15m')).resolves.toContain('signed.test/r.pdf')
  })

  it('rejects a non-positive lifetime', async () => {
    const disk = new Disk('s', new SigningDriver(), { scope: null })
    await expect(disk.temporaryUrl('r.pdf', 0)).rejects.toBeInstanceOf(TemporaryUrlTtlTooLongError)
  })

  it('maxTemporaryUrlTtl tightens the cap per disk, and is honoured through storagePlugin', async () => {
    const tight = new Disk('s', new SigningDriver(), { scope: null, maxTemporaryUrlTtl: '1h' })
    await expect(tight.temporaryUrl('r.pdf', '2h')).rejects.toBeInstanceOf(TemporaryUrlTtlTooLongError)
    await expect(tight.temporaryUrl('r.pdf', '30m')).resolves.toBeTypeOf('string')

    const app = await createApp({
      plugins: [storagePlugin({ disks: { s: { driver: new SigningDriver(), scope: null, maxTemporaryUrlTtl: '1h' } } })],
    }).boot()
    await expect(app.container.get(STORAGE).disk('s').temporaryUrl('r.pdf', '2h')).rejects.toBeInstanceOf(
      TemporaryUrlTtlTooLongError,
    )
  })
})
