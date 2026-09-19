import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Disk, StorageFileNotFoundError, StorageTooLargeError } from '@basaltkit/storage'
import { AzureBlobStorageDriver, type AzureBlobLike, type AzureContainerLike } from '../src/index.js'

interface Stored {
  body: Buffer
  contentType?: string
}

/** A container whose block blobs support the streaming/copy/stat capabilities. */
class FakeAzureContainer implements AzureContainerLike {
  readonly blobs = new Map<string, Stored>()
  readonly copies: { from: string; to: string; source: string; contentType?: string }[] = []
  getBlockBlobClient(path: string): AzureBlobLike {
    const container = this
    const store = this.blobs
    return {
      url: `https://azure.test/c/${path}`,
      async uploadData(data: Buffer, options) {
        store.set(path, { body: data, ...(options?.blobHTTPHeaders?.blobContentType !== undefined ? { contentType: options.blobHTTPHeaders.blobContentType } : {}) })
      },
      async uploadStream(stream: Readable, _size, _concurrency, options) {
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
        store.set(path, {
          body: Buffer.concat(chunks),
          ...(options?.blobHTTPHeaders?.blobContentType !== undefined ? { contentType: options.blobHTTPHeaders.blobContentType } : {}),
        })
      },
      async download() {
        const blob = store.get(path)
        if (!blob) {
          const error = new Error('not found') as Error & { statusCode: number }
          error.statusCode = 404
          throw error
        }
        return { readableStreamBody: Readable.from([blob.body]) }
      },
      async syncCopyFromURL(source: string, options) {
        const from = source.split('?')[0]?.split('/c/')[1] ?? ''
        const blob = store.get(from)
        if (!blob) throw new Error(`fake: unknown copy source ${source}`)
        container.copies.push({ from, to: path, source, ...(options?.blobHTTPHeaders?.blobContentType !== undefined ? { contentType: options.blobHTTPHeaders.blobContentType } : {}) })
        store.set(path, { ...blob, ...(options?.blobHTTPHeaders?.blobContentType !== undefined ? { contentType: options.blobHTTPHeaders.blobContentType } : {}) })
      },
      async getProperties() {
        const blob = store.get(path)
        if (!blob) {
          const error = new Error('not found') as Error & { statusCode: number }
          error.statusCode = 404
          throw error
        }
        return {
          contentLength: blob.body.byteLength,
          ...(blob.contentType !== undefined ? { contentType: blob.contentType } : {}),
          etag: '"az-etag"',
          lastModified: new Date('2026-09-01T10:00:00Z'),
        }
      },
      async downloadToBuffer(): Promise<Buffer> {
        const blob = store.get(path)
        if (!blob) {
          const error = new Error('not found') as Error & { statusCode: number }
          error.statusCode = 404
          throw error
        }
        return blob.body
      },
      async exists(): Promise<boolean> {
        return store.has(path)
      },
      async deleteIfExists(): Promise<{ succeeded: boolean }> {
        return { succeeded: store.delete(path) }
      },
      async generateSasUrl(options): Promise<string> {
        return `https://azure.test/c/${path}?sas&p=${options.permissions}&expires=${options.expiresOn.getTime()}`
      },
    }
  }
  async *listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }> {
    const prefix = options?.prefix ?? ''
    for (const name of this.blobs.keys()) if (name.startsWith(prefix)) yield { name }
  }
}

const make = () => {
  const client = new FakeAzureContainer()
  const driver = new AzureBlobStorageDriver({ container: 'c', client })
  return { client, driver, disk: new Disk('blobs', driver, { scope: null }) }
}

const read = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString()
}

describe('AzureBlobStorageDriver streaming (BK-019)', () => {
  it('uploads a stream through uploadStream, with the content type', async () => {
    const { disk, client } = make()
    await disk.putStream('a/b.txt', Readable.from([Buffer.from('hello '), Buffer.from('azure')]), { contentType: 'text/plain' })
    expect(client.blobs.get('a/b.txt')).toEqual({ body: Buffer.from('hello azure'), contentType: 'text/plain' })
  })

  it('uploads a body of unknown length (no contentLength needed)', async () => {
    const { disk, client } = make()
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(Buffer.from('a'))
      yield new Uint8Array(Buffer.from('b'))
    }
    await disk.putStream('a.bin', chunks(), { contentType: 'application/octet-stream' })
    expect(client.blobs.get('a.bin')?.body.toString()).toBe('ab')
  })

  it('aborts past maxBytes and destroys the source', async () => {
    const { disk, client } = make()
    const source = Readable.from(Array.from({ length: 10 }, () => Buffer.alloc(40)))
    await expect(disk.putStream('big', source, { contentType: 'application/octet-stream', maxBytes: 100 })).rejects.toBeInstanceOf(
      StorageTooLargeError,
    )
    expect(source.destroyed).toBe(true)
    // The fake writes only once the stream ends, so nothing was stored.
    expect(client.blobs.has('big')).toBe(false)
  })

  it('downloads as a stream, and reports a missing blob as not found', async () => {
    const { disk } = make()
    await disk.put('a.txt', 'streamed azure')
    expect(await read(await disk.getStream('a.txt'))).toBe('streamed azure')
    await expect(disk.getStream('missing')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('copies server-side through a short-lived read SAS', async () => {
    const { disk, client } = make()
    await disk.put('drafts/a.txt', 'contract', { contentType: 'text/plain' })
    await disk.copy('drafts/a.txt', 'final/a.txt')
    expect(client.blobs.get('final/a.txt')?.body.toString()).toBe('contract')
    const copy = client.copies[0]
    expect(copy?.from).toBe('drafts/a.txt')
    expect(copy?.to).toBe('final/a.txt')
    // Read-only SAS, never a write credential.
    expect(copy?.source).toContain('p=r')
  })

  it('reports a missing copy source as not found', async () => {
    const { disk } = make()
    await expect(disk.copy('missing', 'b')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('stats a blob from getProperties', async () => {
    const { disk } = make()
    await disk.put('a.pdf', Buffer.alloc(2048), { contentType: 'application/pdf' })
    expect(await disk.stat('a.pdf')).toEqual({
      size: 2048,
      contentType: 'application/pdf',
      etag: '"az-etag"',
      lastModified: new Date('2026-09-01T10:00:00Z'),
    })
    await expect(disk.stat('missing')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('scopes streaming keys to the tenant', async () => {
    const client = new FakeAzureContainer()
    const disk = new Disk('blobs', new AzureBlobStorageDriver({ container: 'c', client }), { scope: () => 'tenants/acme' })
    await disk.putStream('a.txt', Readable.from(['x']), { contentType: 'text/plain' })
    await disk.copy('a.txt', 'b.txt')
    expect([...client.blobs.keys()].sort()).toEqual(['tenants/acme/a.txt', 'tenants/acme/b.txt'])
  })

  it('reports the capability as unsupported when the injected client lacks the method', async () => {
    const client = new FakeAzureContainer()
    const bare: AzureContainerLike = {
      getBlockBlobClient(path) {
        const { uploadStream: _u, download: _d, syncCopyFromURL: _c, getProperties: _p, ...rest } = client.getBlockBlobClient(path)
        return rest
      },
      listBlobsFlat: (options) => client.listBlobsFlat(options),
    }
    const disk = new Disk('blobs', new AzureBlobStorageDriver({ container: 'c', client: bare }), { scope: null })
    await expect(disk.putStream('a', Readable.from(['x']), { contentType: 'text/plain' })).rejects.toMatchObject({
      code: 'STORAGE_PUT_STREAM_UNSUPPORTED',
    })
    await expect(disk.getStream('a')).rejects.toMatchObject({ code: 'STORAGE_GET_STREAM_UNSUPPORTED' })
    await expect(disk.copy('a', 'b')).rejects.toMatchObject({ code: 'STORAGE_COPY_UNSUPPORTED' })
    await expect(disk.stat('a')).rejects.toMatchObject({ code: 'STORAGE_STAT_UNSUPPORTED' })
  })
})
