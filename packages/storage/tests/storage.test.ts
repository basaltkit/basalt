import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import {
  Disk,
  LocalStorageDriver,
  STORAGE,
  storagePlugin,
  StorageContentTypeError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageTooLargeError,
} from '../src/index.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-storage-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const makeDisk = (options = {}) => new Disk('uploads', new LocalStorageDriver({ root }), options)

describe('Disk (local driver)', () => {
  it('put/get round-trips buffers and strings, creating directories', async () => {
    const disk = makeDisk({ scope: null })
    await disk.put('docs/readme.txt', 'hello')
    await disk.put('img/pixel.bin', Buffer.from([1, 2, 3]))

    expect((await disk.get('docs/readme.txt')).toString()).toBe('hello')
    expect([...(await disk.get('img/pixel.bin'))]).toEqual([1, 2, 3])
  })

  it('exists/delete/list behave consistently', async () => {
    const disk = makeDisk({ scope: null })
    await disk.put('a/1.txt', 'x')
    await disk.put('a/b/2.txt', 'y')
    await disk.put('c/3.txt', 'z')

    expect(await disk.exists('a/1.txt')).toBe(true)
    expect(await disk.list('a')).toEqual(['a/1.txt', 'a/b/2.txt'])
    expect(await disk.delete('a/1.txt')).toBe(true)
    expect(await disk.delete('a/1.txt')).toBe(false)
    expect(await disk.exists('a/1.txt')).toBe(false)
  })

  it('throws a typed error for missing files', async () => {
    const disk = makeDisk({ scope: null })
    await expect(disk.get('nope.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError)
    await expect(disk.get('nope.txt')).rejects.toMatchObject({ code: 'STORAGE_FILE_NOT_FOUND' })
  })

  it('blocks path traversal outside the disk root', async () => {
    const disk = makeDisk({ scope: null })
    await expect(disk.put('../escape.txt', 'x')).rejects.toMatchObject({
      code: 'STORAGE_INVALID_KEY',
    })
    await expect(disk.get('a/../../escape.txt')).rejects.toMatchObject({
      code: 'STORAGE_INVALID_KEY',
    })
  })

  it('isolates tenants automatically via context', async () => {
    const disk = makeDisk()

    await runWithContext({ tenant: { id: 'acme' } }, () => disk.put('logo.png', 'acme-logo'))
    await runWithContext({ tenant: { id: 'globex' } }, () => disk.put('logo.png', 'globex-logo'))
    await disk.put('logo.png', 'central-logo')

    const read = (tenantId?: string) =>
      tenantId
        ? runWithContext({ tenant: { id: tenantId } }, async () =>
            (await disk.get('logo.png')).toString(),
          )
        : disk.get('logo.png').then((buffer) => buffer.toString())

    expect(await read('acme')).toBe('acme-logo')
    expect(await read('globex')).toBe('globex-logo')
    expect(await read()).toBe('central-logo')

    // tenant files live under tenants/<id>/ — visible without scope
    const unscoped = makeDisk({ scope: null })
    expect(await unscoped.list('tenants/acme')).toEqual(['tenants/acme/logo.png'])
  })

  it('temporaryUrl on the local driver fails with a typed error', async () => {
    const disk = makeDisk({ scope: null })
    await disk.put('report.pdf', 'x')
    expect(() => disk.temporaryUrl('report.pdf', '15m')).toThrowError(/does not support/)
  })
})

describe('storagePlugin', () => {
  it('registers named disks with a default and rejects unknown disks', async () => {
    const app = await createApp({
      plugins: [
        storagePlugin({
          default: 'uploads',
          disks: { uploads: { driver: 'local', root, scope: null } },
        }),
      ],
    }).boot()

    const storage = app.container.get(STORAGE)
    await storage.disk().put('via-plugin.txt', 'ok')
    expect((await storage.disk('uploads').get('via-plugin.txt')).toString()).toBe('ok')
    expect(() => storage.disk('missing')).toThrowError(/Unknown disk/)
    await app.shutdown()
  })

  it('accepts a custom StorageDriver instance', async () => {
    const driver = new LocalStorageDriver({ root })
    const app = await createApp({
      plugins: [storagePlugin({ default: 'd', disks: { d: { driver, scope: null } } })],
    }).boot()
    await app.container.get(STORAGE).disk().put('custom.txt', 'yes')
    expect((await driver.get('custom.txt')).toString()).toBe('yes') // wrote through the instance
    await app.shutdown()
  })
})

describe('Disk tenant-scope path safety', () => {
  it('rejects traversal so a scoped key cannot escape its tenant prefix', async () => {
    const disk = new Disk('uploads', new LocalStorageDriver({ root }), {
      scope: () => 'tenants/t1',
    })
    await disk.put('ok/file.txt', 'x') // normal key still works
    expect((await disk.get('ok/file.txt')).toString()).toBe('x')

    // A caller-supplied `..` must NOT reach another tenant's prefix.
    await expect(disk.get('../../tenants/t2/secret.txt')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.put('../t2/x.txt', 'evil')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.delete('/etc/passwd')).rejects.toBeInstanceOf(StorageInvalidKeyError)
  })
})

describe('Disk key validation (L-3, shared across all drivers)', () => {
  it('rejects leading-slash, backslash, .. and control-char keys', async () => {
    const disk = makeDisk({ scope: null })
    await expect(disk.put('/leading.txt', 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.put('\\windows.txt', 'x')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.put('a/../b.txt', 'x')).rejects.toMatchObject({ code: 'STORAGE_INVALID_KEY' })
    await expect(disk.put('bad\x00name.txt', 'x')).rejects.toMatchObject({
      code: 'STORAGE_INVALID_KEY',
    })
    // list() and get() go through the same choke point
    await expect(disk.list('../etc')).rejects.toBeInstanceOf(StorageInvalidKeyError)
  })

  it('allows a normal nested key like avatars/123/pic.png', async () => {
    const disk = makeDisk({ scope: null })
    await disk.put('avatars/123/pic.png', Buffer.from([9, 8, 7]))
    expect([...(await disk.get('avatars/123/pic.png'))]).toEqual([9, 8, 7])
    expect(await disk.list('avatars')).toEqual(['avatars/123/pic.png'])
  })
})

describe('Disk upload validation (L-4, opt-in, enforced at the facade)', () => {
  it('rejects a Buffer larger than maxBytes with STORAGE_TOO_LARGE', async () => {
    const disk = makeDisk({ scope: null })
    await expect(
      disk.put('big.bin', Buffer.alloc(11), { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(StorageTooLargeError)
    await expect(disk.put('big.txt', 'x'.repeat(11), { maxBytes: 10 })).rejects.toMatchObject({
      code: 'STORAGE_TOO_LARGE',
    })
    // within the cap still writes
    await disk.put('ok.bin', Buffer.alloc(10), { maxBytes: 10 })
    expect(await disk.exists('ok.bin')).toBe(true)
  })

  it('enforces allowedContentTypes: rejects disallowed, allows allowed', async () => {
    const disk = makeDisk({ scope: null })
    await expect(
      disk.put('x.exe', 'data', {
        contentType: 'application/octet-stream',
        allowedContentTypes: ['image/png', 'image/jpeg'],
      }),
    ).rejects.toBeInstanceOf(StorageContentTypeError)
    // a missing content type is also rejected when an allowlist is set
    await expect(
      disk.put('x.png', 'data', { allowedContentTypes: ['image/png'] }),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTENT_TYPE' })
    // an allowed type writes through
    await disk.put('ok.png', 'data', {
      contentType: 'image/png',
      allowedContentTypes: ['image/png', 'image/jpeg'],
    })
    expect(await disk.exists('ok.png')).toBe(true)
  })

  it('leaves existing behavior unchanged when no limits are set', async () => {
    const disk = makeDisk({ scope: null })
    await disk.put('anything.bin', Buffer.alloc(1000), { contentType: 'application/x-weird' })
    expect(await disk.exists('anything.bin')).toBe(true)
  })
})
