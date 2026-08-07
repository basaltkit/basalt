import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@machize/core'
import {
  Disk,
  LocalStorageDriver,
  STORAGE,
  storagePlugin,
  StorageFileNotFoundError,
} from '../src/index.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'machize-storage-'))
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
      code: 'STORAGE_INVALID_PATH',
    })
    await expect(disk.get('a/../../escape.txt')).rejects.toMatchObject({
      code: 'STORAGE_INVALID_PATH',
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
