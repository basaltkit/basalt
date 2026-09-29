import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { Disk, LocalStorageDriver, type PutOptions, type StorageDriver } from '../src/index.js'

/**
 * Models an object store's listing (S3 `ListObjectsV2`, GCS `getFiles`, Azure
 * `listBlobsFlat`): the prefix is a plain STRING prefix, not a directory, and
 * keys come back in full.
 */
class ObjectStoreDriver implements StorageDriver {
  readonly name = 'object-store'
  readonly files = new Map<string, Buffer>()
  async put(path: string, content: Buffer | string, _options?: PutOptions): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
  }
  async get(path: string): Promise<Buffer> {
    const buffer = this.files.get(path)
    if (!buffer) throw new Error(`not found: ${path}`)
    return buffer
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async delete(path: string): Promise<boolean> {
    return this.files.delete(path)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort()
  }
  async disconnect(): Promise<void> {}
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const drivers: [string, () => Promise<StorageDriver>][] = [
  ['object store', async () => new ObjectStoreDriver()],
  [
    'local',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'basalt-list-'))
      roots.push(root)
      return new LocalStorageDriver({ root })
    },
  ],
]

const as = <T>(tenant: string, fn: () => Promise<T>) => runWithContext({ tenant: { id: tenant } } as never, fn)

describe.each(drivers)('Disk.list returns scope-relative keys (%s)', (_label, make) => {
  it('hands back keys that get() accepts as-is — no doubled tenant prefix', async () => {
    const disk = new Disk('uploads', await make())
    const keys = await as('acme', async () => {
      await disk.put('a/1.txt', 'one')
      await disk.put('a/b/2.txt', 'two')
      return disk.list()
    })
    expect(keys).toEqual(['a/1.txt', 'a/b/2.txt'])
    const contents = await as('acme', () => Promise.all(keys.map(async (key) => (await disk.get(key)).toString())))
    expect(contents).toEqual(['one', 'two'])
  })

  it('lists only the current tenant, relative to its scope', async () => {
    const disk = new Disk('uploads', await make())
    await as('acme', () => disk.put('x.txt', 'a'))
    await as('globex', () => disk.put('y.txt', 'g'))
    expect(await as('acme', () => disk.list(''))).toEqual(['x.txt'])
    expect(await as('globex', () => disk.list(''))).toEqual(['y.txt'])
  })

  it('treats a prefix as a directory on every driver: "a" never matches "ab/…"', async () => {
    const disk = new Disk('uploads', await make(), { scope: null })
    await disk.put('a/1.txt', '1')
    await disk.put('ab/2.txt', '2')
    await disk.put('a.txt', '3')
    expect(await disk.list('a')).toEqual(['a/1.txt'])
    expect(await disk.list('a/')).toEqual(['a/1.txt'])
  })

  it('keeps full keys on a central disk, where the key IS the whole path', async () => {
    const driver = await make()
    const scoped = new Disk('uploads', driver)
    const central = new Disk('central', driver, { scope: null })
    await as('acme', () => scoped.put('logo.png', 'x'))
    expect(await central.list('tenants/acme')).toEqual(['tenants/acme/logo.png'])
    // …and a central listing of another tenant's tree does not leak a
    // neighbour whose id merely starts the same way.
    await as('acme2', () => scoped.put('logo.png', 'y'))
    expect(await central.list('tenants/acme')).toEqual(['tenants/acme/logo.png'])
  })
})
