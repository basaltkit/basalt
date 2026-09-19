import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  CopyUnsupportedError,
  Disk,
  GetStreamUnsupportedError,
  LocalStorageDriver,
  PutStreamUnsupportedError,
  StatUnsupportedError,
  StorageContentTypeError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageTenantRequiredError,
  StorageTooLargeError,
  type PutOptions,
  type StorageDriver,
} from '../src/index.js'

const roots: string[] = []
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'basalt-storage-stream-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const localDisk = async (name = 'uploads', options = {}) => {
  const root = await makeRoot()
  const driver = new LocalStorageDriver({ root })
  return { root, driver, disk: new Disk(name, driver, { scope: null, ...options }) }
}

const as = <T>(id: string, fn: () => Promise<T>) => runWithContext({ tenant: { id } } as never, fn)

const read = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

/** An async generator that records how far it was pulled and whether it was closed early. */
function tracked(chunks: Buffer[]) {
  const state = { pulled: 0, closed: false }
  async function* gen(): AsyncGenerator<Uint8Array> {
    try {
      for (const chunk of chunks) {
        state.pulled++
        yield chunk
      }
    } finally {
      state.closed = true
    }
  }
  return { iterable: gen(), state }
}

/** A driver with none of the optional capabilities. */
class BareDriver implements StorageDriver {
  readonly name = 'bare'
  readonly files = new Map<string, Buffer>()
  readonly types = new Map<string, string | undefined>()
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
    this.types.set(path, options?.contentType)
  }
  async get(path: string): Promise<Buffer> {
    const buffer = this.files.get(path)
    if (!buffer) throw new StorageFileNotFoundError(path)
    return buffer
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async delete(path: string): Promise<boolean> {
    return this.files.delete(path)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix))
  }
  async disconnect(): Promise<void> {}
}

describe('Disk.putStream (BK-019)', () => {
  it('streams the body to the driver and never buffers it whole', async () => {
    const { disk, root } = await localDisk()
    const chunks = [Buffer.from('hello '), Buffer.from('streamed '), Buffer.from('world')]
    await disk.putStream('imports/a.txt', Readable.from(chunks), { contentType: 'text/plain' })
    expect((await readFile(join(root, 'imports/a.txt'))).toString()).toBe('hello streamed world')
  })

  it.each([
    ['Node Readable', (c: Buffer[]) => Readable.from(c)],
    ['AsyncIterable<Uint8Array>', (c: Buffer[]) => tracked(c).iterable],
    ['web ReadableStream', (c: Buffer[]) => ReadableStream.from(c.map((chunk) => new Uint8Array(chunk)))],
  ])('accepts a %s', async (_label, source) => {
    const { disk } = await localDisk()
    await disk.putStream('a.bin', source([Buffer.from('ab'), Buffer.from('cd')]), { contentType: 'application/octet-stream' })
    expect((await disk.get('a.bin')).toString()).toBe('abcd')
  })

  it('applies the tenant scope prefix to the key', async () => {
    const root = await makeRoot()
    const disk = new Disk('uploads', new LocalStorageDriver({ root }))
    await as('acme', () => disk.putStream('a.txt', Readable.from([Buffer.from('x')]), { contentType: 'text/plain' }))
    expect((await readFile(join(root, 'tenants/acme/a.txt'))).toString()).toBe('x')
  })

  it('fails closed without a tenant and rejects traversal keys', async () => {
    const root = await makeRoot()
    const disk = new Disk('uploads', new LocalStorageDriver({ root }), { onMissingScope: 'error' })
    await expect(disk.putStream('a.txt', Readable.from(['x']), { contentType: 'text/plain' })).rejects.toBeInstanceOf(
      StorageTenantRequiredError,
    )
    await expect(
      as('acme', () => disk.putStream('../escape.txt', Readable.from(['x']), { contentType: 'text/plain' })),
    ).rejects.toBeInstanceOf(StorageInvalidKeyError)
  })

  it('enforces maxBytes WHILE streaming: stops pulling, closes the source, leaves no object', async () => {
    const { disk, driver } = await localDisk()
    const { iterable, state } = tracked(Array.from({ length: 50 }, () => Buffer.alloc(40)))
    await expect(disk.putStream('big.bin', iterable, { contentType: 'application/octet-stream', maxBytes: 100 })).rejects.toBeInstanceOf(
      StorageTooLargeError,
    )
    expect(state.pulled).toBe(3)
    expect(state.closed).toBe(true)
    expect(await driver.exists('big.bin')).toBe(false)
  })

  it('destroys a Node Readable and cancels a web ReadableStream past maxBytes', async () => {
    const { disk } = await localDisk()
    const readable = Readable.from([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)])
    await expect(disk.putStream('a', readable, { contentType: 'application/octet-stream', maxBytes: 10 })).rejects.toBeInstanceOf(
      StorageTooLargeError,
    )
    expect(readable.destroyed).toBe(true)

    let cancelled = false
    const web = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(disk.putStream('b', web, { contentType: 'application/octet-stream', maxBytes: 10 })).rejects.toBeInstanceOf(
      StorageTooLargeError,
    )
    expect(cancelled).toBe(true)
  })

  it('refuses a declared contentLength over maxBytes before reading a byte', async () => {
    const { disk } = await localDisk()
    const { iterable, state } = tracked([Buffer.alloc(10)])
    await expect(
      disk.putStream('a', iterable, { contentType: 'text/plain', contentLength: 5_000, maxBytes: 100 }),
    ).rejects.toBeInstanceOf(StorageTooLargeError)
    expect(state.pulled).toBe(0)
  })

  it('refuses a content type outside allowedContentTypes before reading a byte', async () => {
    const { disk } = await localDisk()
    const { iterable, state } = tracked([Buffer.alloc(10)])
    await expect(
      disk.putStream('a', iterable, { contentType: 'text/html', allowedContentTypes: ['image/png'] }),
    ).rejects.toBeInstanceOf(StorageContentTypeError)
    expect(state.pulled).toBe(0)
  })

  it('throws STORAGE_PUT_STREAM_UNSUPPORTED on a driver without the capability', async () => {
    const disk = new Disk('bare', new BareDriver(), { scope: null })
    await expect(disk.putStream('a', Readable.from(['x']), { contentType: 'text/plain' })).rejects.toMatchObject({
      code: 'STORAGE_PUT_STREAM_UNSUPPORTED',
    })
    expect(disk.supports('putStream')).toBe(false)
  })
})

describe('Disk.getStream (BK-019)', () => {
  it('reads the object as a stream, tenant-scoped', async () => {
    const root = await makeRoot()
    const disk = new Disk('uploads', new LocalStorageDriver({ root }))
    await mkdir(join(root, 'tenants/acme'), { recursive: true })
    await writeFile(join(root, 'tenants/acme/a.txt'), 'streamed back')
    const stream = await as('acme', () => disk.getStream('a.txt'))
    expect((await read(stream)).toString()).toBe('streamed back')
  })

  it('throws the not-found error for a missing object', async () => {
    const { disk } = await localDisk()
    await expect(disk.getStream('missing.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('throws STORAGE_GET_STREAM_UNSUPPORTED on a driver without the capability', async () => {
    const disk = new Disk('bare', new BareDriver(), { scope: null })
    await expect(disk.getStream('a')).rejects.toBeInstanceOf(GetStreamUnsupportedError)
  })
})

describe('Disk.copy (BK-019)', () => {
  it('copies server-side within the same driver', async () => {
    const { disk, root } = await localDisk()
    await disk.put('drafts/a.txt', 'contract')
    await disk.copy('drafts/a.txt', 'final/a.txt')
    expect((await readFile(join(root, 'final/a.txt'))).toString()).toBe('contract')
    expect(await disk.exists('drafts/a.txt')).toBe(true)
  })

  it('scopes both keys, each against its own disk', async () => {
    const root = await makeRoot()
    const driver = new LocalStorageDriver({ root })
    const disk = new Disk('uploads', driver)
    const cold = new Disk('cold', driver, { scope: () => 'archive' })
    await as('acme', async () => {
      await disk.put('a.txt', 'bytes')
      await disk.copy('a.txt', 'a.txt', { disk: cold })
    })
    expect((await readFile(join(root, 'archive/a.txt'))).toString()).toBe('bytes')
  })

  it('refuses a traversal key on either side', async () => {
    const { disk } = await localDisk()
    await disk.put('a.txt', 'x')
    await expect(disk.copy('../a.txt', 'b.txt')).rejects.toBeInstanceOf(StorageInvalidKeyError)
    await expect(disk.copy('a.txt', '../b.txt')).rejects.toBeInstanceOf(StorageInvalidKeyError)
  })

  it('throws the not-found error when the source is missing', async () => {
    const { disk } = await localDisk()
    await expect(disk.copy('missing.txt', 'b.txt')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('falls back to getStream → putStream across different drivers', async () => {
    const source = await localDisk('hot')
    const target = await localDisk('cold')
    await source.disk.put('a.txt', 'crossing drivers', { contentType: 'text/plain' })
    await source.disk.copy('a.txt', 'b.txt', { disk: target.disk })
    expect((await target.disk.get('b.txt')).toString()).toBe('crossing drivers')
  })

  it('falls back to get → put when neither driver streams', async () => {
    const driverA = new BareDriver()
    const driverB = new BareDriver()
    const from = new Disk('a', driverA, { scope: null })
    const to = new Disk('b', driverB, { scope: null })
    await from.put('a.txt', 'buffered copy', { contentType: 'text/plain' })
    await from.copy('a.txt', 'b.txt', { disk: to, contentType: 'text/plain' })
    expect(driverB.files.get('b.txt')?.toString()).toBe('buffered copy')
    expect(driverB.types.get('b.txt')).toBe('text/plain')
  })

  it('caps the fallback copy with maxBytes', async () => {
    const source = await localDisk('hot')
    const target = await localDisk('cold')
    await source.disk.put('a.bin', Buffer.alloc(4096))
    await expect(source.disk.copy('a.bin', 'b.bin', { disk: target.disk, maxBytes: 10 })).rejects.toBeInstanceOf(StorageTooLargeError)
  })

  it('throws STORAGE_COPY_UNSUPPORTED with requireServerSide when no server-side copy is possible', async () => {
    const from = new Disk('a', new BareDriver(), { scope: null })
    await from.put('a', 'x')
    await expect(from.copy('a', 'b', { requireServerSide: true })).rejects.toBeInstanceOf(CopyUnsupportedError)

    const source = await localDisk('hot')
    const target = await localDisk('cold')
    await source.disk.put('a.txt', 'x')
    // Two local drivers, but two different driver instances: not one backend.
    await expect(source.disk.copy('a.txt', 'b.txt', { disk: target.disk, requireServerSide: true })).rejects.toMatchObject({
      code: 'STORAGE_COPY_UNSUPPORTED',
    })
  })
})

describe('Disk.stat (BK-019)', () => {
  it('reports the size without downloading the object', async () => {
    const { disk } = await localDisk()
    await disk.put('a.bin', Buffer.alloc(1234))
    const stat = await disk.stat('a.bin')
    expect(stat.size).toBe(1234)
    expect(stat.lastModified).toBeInstanceOf(Date)
  })

  it('is tenant-scoped and throws the not-found error for a missing object', async () => {
    const root = await makeRoot()
    const disk = new Disk('uploads', new LocalStorageDriver({ root }))
    await as('acme', () => disk.put('a.bin', 'xyz'))
    expect((await as('acme', () => disk.stat('a.bin'))).size).toBe(3)
    await expect(as('globex', () => disk.stat('a.bin'))).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('throws STORAGE_STAT_UNSUPPORTED on a driver without the capability', async () => {
    const disk = new Disk('bare', new BareDriver(), { scope: null })
    await expect(disk.stat('a')).rejects.toBeInstanceOf(StatUnsupportedError)
  })
})

describe('Disk.supports (BK-019)', () => {
  it('reports the optional capabilities of the driver', async () => {
    const { disk } = await localDisk()
    expect(disk.supports('putStream')).toBe(true)
    expect(disk.supports('getStream')).toBe(true)
    expect(disk.supports('copy')).toBe(true)
    expect(disk.supports('stat')).toBe(true)
    expect(disk.supports('temporaryUrl')).toBe(false)
  })
})
