import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext, tryCtx } from '@basaltkit/core'
import {
  Disk,
  LocalStorageDriver,
  STORAGE,
  storagePlugin,
  StorageCrossTenantCopyError,
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
    await new Disk('central', new LocalStorageDriver({ root }), { scope: null }).put('central.txt', 'CENTRAL')

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

// Regressions for the 2026-09 framework audit (FA-028, FA-029, FA-033).
describe('security: the default tenant segment is canonical (FA-028)', () => {
  it('"Acme" never reaches "acme"\'s tree — refused on every platform, like every driver', async () => {
    const disk = new Disk('uploads', new LocalStorageDriver({ root }))
    await as('acme', () => disk.put('x.txt', 'secret'))
    // On APFS/NTFS 'tenants/Acme' used to open 'tenants/acme'; S3 kept them apart.
    for (const id of ['Acme', 'ACME', 'acme\u0301', 'caf\u00e9', 'acme.', ' acme', 'ac me']) {
      await expect(as(id, () => disk.get('x.txt')), JSON.stringify(id)).rejects.toBeInstanceOf(StorageInvalidScopeError)
      await expect(as(id, () => disk.put('y.txt', 'poison')), JSON.stringify(id)).rejects.toBeInstanceOf(StorageInvalidScopeError)
    }
    expect((await as('acme', () => disk.get('x.txt'))).toString()).toBe('secret')
    expect(await new Disk('c', new LocalStorageDriver({ root }), { scope: null }).list('')).toEqual(['tenants/acme/x.txt'])
  })

  it('accepts the tenancy default grammar and dotted ids', async () => {
    const disk = new Disk('uploads', new LocalStorageDriver({ root }))
    for (const id of ['acme', 'a', '0', 'acme-corp_2', '0f8fad5b-d9cb-469f-a165-70867728950e', 'acme.eu']) {
      await as(id, () => disk.put('x.txt', id))
      expect((await as(id, () => disk.get('x.txt'))).toString()).toBe(id)
    }
  })

  it('a custom scope is the escape hatch for non-canonical ids', async () => {
    // Case-preserving ids (nanoid, ULID) map to a canonical, collision-free segment.
    const tenantHex = () => {
      const id = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
      return id ? `tenants/x${Buffer.from(id).toString('hex')}` : undefined
    }
    const disk = new Disk('uploads', new LocalStorageDriver({ root }), { scope: tenantHex })
    await as('Acme', () => disk.put('x.txt', 'upper'))
    await as('acme', () => disk.put('x.txt', 'lower'))
    expect((await as('Acme', () => disk.get('x.txt'))).toString()).toBe('upper')
    expect((await as('acme', () => disk.get('x.txt'))).toString()).toBe('lower')
  })
})

describe('security: a scoped disk without a scope fails closed unless told otherwise (FA-029)', () => {
  it('a custom scope resolving nothing refuses instead of using the bucket root', async () => {
    const central = new Disk('c', new LocalStorageDriver({ root }), { scope: null })
    await central.put('tenants/globex/a', 'g')
    const disk = new Disk('d', new LocalStorageDriver({ root }), { scope: () => undefined }, () => true)
    await expect(disk.list('')).rejects.toBeInstanceOf(StorageTenantRequiredError)
    await expect(disk.get('tenants/globex/a')).rejects.toBeInstanceOf(StorageTenantRequiredError)
    // even when the host says tenancy is not registered: a custom scope has no root fallback
    const single = new Disk('d', new LocalStorageDriver({ root }), { scope: () => undefined }, () => false)
    await expect(single.list('')).rejects.toBeInstanceOf(StorageTenantRequiredError)
  })

  it('a hand-built default-scope disk with no tenant in context refuses too', async () => {
    const central = new Disk('c', new LocalStorageDriver({ root }), { scope: null })
    await central.put('tenants/globex/a', 'g')
    const disk = new Disk('d', new LocalStorageDriver({ root }))
    await expect(disk.get('tenants/globex/a')).rejects.toMatchObject({ code: 'STORAGE_TENANT_REQUIRED', status: 400 })
    await expect(disk.list('tenants')).rejects.toBeInstanceOf(StorageTenantRequiredError)
  })

  it("'root' only when asked for: onMissingScope:'root' or scope:null", async () => {
    const central = new Disk('c', new LocalStorageDriver({ root }), { scope: null })
    await central.put('tenants/globex/a', 'g')
    const mixed = new Disk('d', new LocalStorageDriver({ root }), { onMissingScope: 'root' })
    expect((await mixed.get('tenants/globex/a')).toString()).toBe('g')
    const custom = new Disk('d', new LocalStorageDriver({ root }), { scope: () => undefined, onMissingScope: 'root' })
    expect(await custom.list('')).toEqual(['tenants/globex/a'])
  })
})

describe('security: copy() cannot write into another tenant through a central disk (FA-033)', () => {
  it("refuses a central destination inside tenants/ from a tenant-scoped disk", async () => {
    const driver = new LocalStorageDriver({ root })
    const scoped = new Disk('d', driver)
    const central = new Disk('c', driver, { scope: null })
    await as('acme', () => scoped.put('a', '1'))
    for (const to of ['tenants/globex/pwn', 'Tenants/globex/pwn', './tenants/globex/pwn', 'tenants\\globex\\pwn', 'tenants/acme/own']) {
      await expect(as('acme', () => scoped.copy('a', to, { disk: central })), to).rejects.toBeInstanceOf(StorageCrossTenantCopyError)
    }
    await expect(as('acme', () => scoped.copy('a', 'tenants/globex/pwn', { disk: central }))).rejects.toMatchObject({
      code: 'STORAGE_CROSS_TENANT_COPY',
      status: 403,
    })
    expect(await central.exists('tenants/globex/pwn')).toBe(false)
    expect(await central.list('tenants/globex')).toEqual([])
  })

  it('still copies to a central disk outside tenants/, and between scoped disks', async () => {
    const driver = new LocalStorageDriver({ root })
    const scoped = new Disk('d', driver)
    const central = new Disk('c', driver, { scope: null })
    await as('acme', () => scoped.put('a', '1'))
    await as('acme', () => scoped.copy('a', 'backups/acme/a', { disk: central }))
    expect((await central.get('backups/acme/a')).toString()).toBe('1')
    // a key merely starting with the letters "tenants" is not the tree
    await as('acme', () => scoped.copy('a', 'tenants-export/a', { disk: central }))
    expect(await central.exists('tenants-export/a')).toBe(true)
    await as('acme', () => scoped.copy('a', 'tenants/globex/pwn'))
    expect(await central.exists('tenants/acme/tenants/globex/pwn')).toBe(true)
    // central → central is the operator's own business
    await central.copy('backups/acme/a', 'tenants/globex/restored')
    expect(await central.exists('tenants/globex/restored')).toBe(true)
  })
})
