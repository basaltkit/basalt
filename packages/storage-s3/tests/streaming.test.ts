import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Disk, StorageFileNotFoundError, StorageTooLargeError } from '@basaltkit/storage'
import { S3StorageDriver, type S3DriverOptions } from '../src/index.js'

const base = {
  bucket: 'test-bucket',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
} satisfies S3DriverOptions

/** Replaces the client transport: every command is recorded, never sent. */
function mockSend(reply: (command: unknown) => unknown = () => ({})) {
  const sent: unknown[] = []
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    sent.push(command)
    return reply(command) as never
  })
  return sent
}

const notFound = () => {
  const error = new Error('NoSuchKey') as Error & { name: string }
  error.name = 'NoSuchKey'
  return error
}

const read = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S3StorageDriver.putStream (BK-019)', () => {
  it('forwards the stream to PutObject when the length is known — nothing is buffered', async () => {
    const sent = mockSend()
    const driver = new S3StorageDriver(base)
    const body = Readable.from([Buffer.from('abcde')])
    await driver.putStream('a.txt', body, { contentType: 'text/plain', contentLength: 5 })
    const command = sent[0] as PutObjectCommand
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command.input.ContentLength).toBe(5)
    expect(command.input.ContentType).toBe('text/plain')
    expect(command.input.Body).toBe(body)
  })

  it('refuses an unknown-length stream with STORAGE_STREAM_LENGTH_REQUIRED', async () => {
    const sent = mockSend()
    const driver = new S3StorageDriver(base)
    await expect(driver.putStream('a.txt', Readable.from(['x']), { contentType: 'text/plain' })).rejects.toMatchObject({
      code: 'STORAGE_STREAM_LENGTH_REQUIRED',
      status: 400,
    })
    expect(sent).toHaveLength(0)
  })

  it('buffers up to maxBytes when the length is unknown, and sends the measured length', async () => {
    const sent = mockSend()
    const driver = new S3StorageDriver(base)
    await driver.putStream('a.txt', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), {
      contentType: 'text/plain',
      maxBytes: 1024,
    })
    const command = sent[0] as PutObjectCommand
    expect(Buffer.isBuffer(command.input.Body)).toBe(true)
    expect((command.input.Body as Buffer).toString()).toBe('abcd')
    expect(command.input.ContentLength).toBe(4)
  })

  it('aborts mid-stream past maxBytes and sends nothing', async () => {
    const sent = mockSend()
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    const source = Readable.from(Array.from({ length: 10 }, () => Buffer.alloc(40)))
    await expect(disk.putStream('big.bin', source, { contentType: 'application/octet-stream', maxBytes: 100 })).rejects.toBeInstanceOf(
      StorageTooLargeError,
    )
    expect(sent).toHaveLength(0)
    expect(source.destroyed).toBe(true)
  })

  it('applies the tenant prefix and the configured server-side encryption', async () => {
    const sent = mockSend()
    const disk = new Disk('uploads', new S3StorageDriver({ ...base, serverSideEncryption: 'AES256' }), { scope: () => 'tenants/acme' })
    await disk.putStream('a.txt', Readable.from(['x']), { contentType: 'text/plain', contentLength: 1 })
    const command = sent[0] as PutObjectCommand
    expect(command.input.Key).toBe('tenants/acme/a.txt')
    expect(command.input.ServerSideEncryption).toBe('AES256')
  })
})

describe('S3StorageDriver.getStream (BK-019)', () => {
  it('returns the GetObject body as a Node Readable', async () => {
    mockSend(() => ({ Body: Readable.from([Buffer.from('hello s3')]) }))
    const driver = new S3StorageDriver(base)
    expect(await read(await driver.getStream('a.txt'))).toBe('hello s3')
  })

  it('wraps a web ReadableStream body', async () => {
    mockSend(() => ({ Body: ReadableStream.from([new Uint8Array(Buffer.from('web body'))]) }))
    const driver = new S3StorageDriver(base)
    expect(await read(await driver.getStream('a.txt'))).toBe('web body')
  })

  it('throws StorageFileNotFoundError for a missing key', async () => {
    mockSend(() => {
      throw notFound()
    })
    const driver = new S3StorageDriver(base)
    await expect(driver.getStream('missing')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })
})

describe('S3StorageDriver.copy (BK-019)', () => {
  it('sends CopyObject with an encoded CopySource — the bytes never reach this process', async () => {
    const sent = mockSend()
    const driver = new S3StorageDriver(base)
    await driver.copy('drafts/a b.pdf', 'final/a b.pdf')
    const command = sent[0] as CopyObjectCommand
    expect(command).toBeInstanceOf(CopyObjectCommand)
    expect(command.input.Bucket).toBe('test-bucket')
    expect(command.input.Key).toBe('final/a b.pdf')
    expect(command.input.CopySource).toBe(encodeURIComponent('test-bucket/drafts/a b.pdf'))
    expect(command.input.MetadataDirective).toBeUndefined()
  })

  it('replaces the metadata when a content type is given', async () => {
    const sent = mockSend()
    await new S3StorageDriver(base).copy('a', 'b', { contentType: 'application/pdf' })
    const command = sent[0] as CopyObjectCommand
    expect(command.input.ContentType).toBe('application/pdf')
    expect(command.input.MetadataDirective).toBe('REPLACE')
  })

  it('scopes both keys to the tenant through the Disk facade', async () => {
    const sent = mockSend()
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: () => 'tenants/acme' })
    await disk.copy('drafts/a.pdf', 'final/a.pdf')
    const command = sent[0] as CopyObjectCommand
    expect(command.input.Key).toBe('tenants/acme/final/a.pdf')
    expect(command.input.CopySource).toBe(encodeURIComponent('test-bucket/tenants/acme/drafts/a.pdf'))
  })

  it('throws StorageFileNotFoundError when the source is missing', async () => {
    mockSend(() => {
      throw notFound()
    })
    await expect(new S3StorageDriver(base).copy('missing', 'b')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })
})

describe('S3StorageDriver.stat (BK-019)', () => {
  it('maps HeadObject onto the shared stat shape', async () => {
    const lastModified = new Date('2026-09-01T10:00:00Z')
    const sent = mockSend(() => ({ ContentLength: 4096, ContentType: 'application/pdf', ETag: '"abc"', LastModified: lastModified }))
    const stat = await new S3StorageDriver(base).stat('a.pdf')
    expect(sent[0]).toBeInstanceOf(HeadObjectCommand)
    expect(stat).toEqual({ size: 4096, contentType: 'application/pdf', etag: '"abc"', lastModified })
  })

  it('throws StorageFileNotFoundError for a missing key', async () => {
    mockSend(() => {
      const error = new Error('NotFound') as Error & { $metadata: { httpStatusCode: number } }
      error.$metadata = { httpStatusCode: 404 }
      throw error
    })
    await expect(new S3StorageDriver(base).stat('missing')).rejects.toBeInstanceOf(StorageFileNotFoundError)
  })

  it('is reachable from the Disk facade, tenant-scoped', async () => {
    const sent = mockSend(() => ({ ContentLength: 1 }))
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: () => 'tenants/acme' })
    expect((await disk.stat('a.pdf')).size).toBe(1)
    expect((sent[0] as GetObjectCommand).input.Key).toBe('tenants/acme/a.pdf')
  })
})
