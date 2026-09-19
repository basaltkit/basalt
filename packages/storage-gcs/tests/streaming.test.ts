import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Disk, StorageFileNotFoundError, StorageTooLargeError } from '@basaltkit/storage'
import { GcsStorageDriver, type GcsBucketLike, type GcsFileLike } from '../src/index.js'

interface Stored {
  body: Buffer
  contentType?: string
}

/** A bucket whose files support the streaming/copy/stat capabilities. */
class FakeGcsBucket implements GcsBucketLike {
  readonly files = new Map<string, Stored>()
  readonly copies: { from: string; to: string }[] = []
  file(path: string): GcsFileLike {
    const bucket = this
    const store = this.files
    const missing = () => {
      const error = new Error('not found') as Error & { code: number }
      error.code = 404
      return error
    }
    return {
      async save(data: Buffer, options) {
        store.set(path, { body: data, ...(options?.contentType !== undefined ? { contentType: options.contentType } : {}) })
      },
      createWriteStream(options): Writable {
        const chunks: Buffer[] = []
        return new Writable({
          write(chunk: Uint8Array, _encoding, callback) {
            chunks.push(Buffer.from(chunk))
            callback()
          },
          final(callback) {
            store.set(path, {
              body: Buffer.concat(chunks),
              ...(options?.contentType !== undefined ? { contentType: options.contentType } : {}),
            })
            callback()
          },
        })
      },
      createReadStream(): Readable {
        const file = store.get(path)
        if (!file) {
          const stream = new PassThrough()
          queueMicrotask(() => stream.destroy(missing()))
          return stream
        }
        return Readable.from([file.body])
      },
      async copy(destination, options) {
        const file = store.get(path)
        if (!file) throw missing()
        const to = typeof destination === 'string' ? destination : (destination as { name?: string }).name
        if (!to) throw new Error('fake: destination has no name')
        bucket.copies.push({ from: path, to })
        store.set(to, { ...file, ...(options?.metadata?.contentType !== undefined ? { contentType: options.metadata.contentType } : {}) })
      },
      async getMetadata() {
        const file = store.get(path)
        if (!file) throw missing()
        return [
          {
            // GCS reports size as a string over JSON.
            size: String(file.body.byteLength),
            ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
            etag: 'gcs-etag',
            updated: '2026-09-01T10:00:00.000Z',
          },
        ]
      },
      async download(): Promise<[Buffer]> {
        const file = store.get(path)
        if (!file) throw missing()
        return [file.body]
      },
      async exists(): Promise<[boolean]> {
        return [store.has(path)]
      },
      async delete() {
        store.delete(path)
      },
      async getSignedUrl(config): Promise<[string]> {
        return [`https://gcs.test/${path}?expires=${config.expires}`]
      },
      // Named so the fake's `copy` can address the destination like the SDK does.
      name: path,
    } as GcsFileLike & { name: string }
  }
  async getFiles(options?: { prefix?: string }): Promise<[{ name: string }[]]> {
    const prefix = options?.prefix ?? ''
    return [[...this.files.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name }))]
  }
}

const make = () => {
  const client = new FakeGcsBucket()
  const driver = new GcsStorageDriver({ bucket: 'b', client })
  return { client, driver, disk: new Disk('objects', driver, { scope: null }) }
}

const read = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString()
}

describe('GcsStorageDriver streaming (BK-019)', () => {
  it('uploads a stream through createWriteStream, with the content type', async () => {
    const { disk, client } = make()
    await disk.putStream('a/b.txt', Readable.from([Buffer.from('hello '), Buffer.from('gcs')]), { contentType: 'text/plain' })
    expect(client.files.get('a/b.txt')).toEqual({ body: Buffer.from('hello gcs'), contentType: 'text/plain' })
  })

  it('uploads a body of unknown length (no contentLength needed)', async () => {
    const { disk, client } = make()
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(Buffer.from('a'))
      yield new Uint8Array(Buffer.from('b'))
    }
    await disk.putStream('a.bin', chunks(), { contentType: 'application/octet-stream' })
    expect(client.files.get('a.bin')?.body.toString()).toBe('ab')
  })

  it('aborts past maxBytes and destroys the source', async () => {
    const { disk, client } = make()
    const source = Readable.from(Array.from({ length: 10 }, () => Buffer.alloc(40)))
    await expect(disk.putStream('big', source, { contentType: 'application/octet-stream', maxBytes: 100 })).rejects.toBeInstanceOf(
      StorageTooLargeError,
    )
    expect(source.destroyed).toBe(true)
    expect(client.files.has('big')).toBe(false)
  })

  it('downloads as a stream, and reports a missing object as not found', async () => {
    const { disk } = make()
    await disk.put('a.txt', 'streamed gcs')
    expect(await read(await disk.getStream('a.txt'))).toBe('streamed gcs')
    await expect(read(await disk.getStream('missing'))).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('copies server-side with file.copy', async () => {
    const { disk, client } = make()
    await disk.put('drafts/a.txt', 'contract', { contentType: 'text/plain' })
    await disk.copy('drafts/a.txt', 'final/a.txt')
    expect(client.copies).toEqual([{ from: 'drafts/a.txt', to: 'final/a.txt' }])
    expect(client.files.get('final/a.txt')?.body.toString()).toBe('contract')
  })

  it('reports a missing copy source as not found', async () => {
    const { disk } = make()
    await expect(disk.copy('missing', 'b')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('stats an object from getMetadata, coercing the string size', async () => {
    const { disk } = make()
    await disk.put('a.pdf', Buffer.alloc(2048), { contentType: 'application/pdf' })
    expect(await disk.stat('a.pdf')).toEqual({
      size: 2048,
      contentType: 'application/pdf',
      etag: 'gcs-etag',
      lastModified: new Date('2026-09-01T10:00:00.000Z'),
    })
    await expect(disk.stat('missing')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('scopes streaming keys to the tenant', async () => {
    const client = new FakeGcsBucket()
    const disk = new Disk('objects', new GcsStorageDriver({ bucket: 'b', client }), { scope: () => 'tenants/acme' })
    await disk.putStream('a.txt', Readable.from(['x']), { contentType: 'text/plain' })
    await disk.copy('a.txt', 'b.txt')
    expect([...client.files.keys()].sort()).toEqual(['tenants/acme/a.txt', 'tenants/acme/b.txt'])
  })

  it('reports the capability as unsupported when the injected client lacks the method', async () => {
    const client = new FakeGcsBucket()
    const bare: GcsBucketLike = {
      file(path) {
        const { createWriteStream: _w, createReadStream: _r, copy: _c, getMetadata: _m, ...rest } = client.file(path)
        return rest
      },
      getFiles: (options) => client.getFiles(options),
    }
    const disk = new Disk('objects', new GcsStorageDriver({ bucket: 'b', client: bare }), { scope: null })
    await expect(disk.putStream('a', Readable.from(['x']), { contentType: 'text/plain' })).rejects.toMatchObject({
      code: 'STORAGE_PUT_STREAM_UNSUPPORTED',
    })
    await expect(disk.getStream('a')).rejects.toMatchObject({ code: 'STORAGE_GET_STREAM_UNSUPPORTED' })
    await expect(disk.copy('a', 'b')).rejects.toMatchObject({ code: 'STORAGE_COPY_UNSUPPORTED' })
    await expect(disk.stat('a')).rejects.toMatchObject({ code: 'STORAGE_STAT_UNSUPPORTED' })
  })
})
