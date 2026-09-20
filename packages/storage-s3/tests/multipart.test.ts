import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { Disk, StorageTooLargeError } from '@basaltkit/storage'
import { S3StorageDriver, S3_MIN_PART_SIZE_BYTES, s3Disk, type S3DriverOptions } from '../src/index.js'

const MiB = 1024 * 1024

const base = {
  bucket: 'test-bucket',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
} satisfies S3DriverOptions

/**
 * Replaces the client transport, answering the multipart handshake the way S3
 * does: `@aws-sdk/lib-storage` is the real one here, so what is asserted is the
 * commands it actually puts on the wire.
 */
function mockSend(fail?: (command: unknown) => void) {
  const sent: unknown[] = []
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    sent.push(command)
    fail?.(command)
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-1' } as never
    if (command instanceof UploadPartCommand) return { ETag: `"part-${(command.input as { PartNumber?: number }).PartNumber}"` } as never
    return {} as never
  })
  return sent
}

/** A stream of `total` bytes in 1 MiB chunks whose length nobody declares. */
const unknownLength = (total: number): Readable =>
  Readable.from(
    (function* () {
      for (let done = 0; done < total; done += MiB) yield Buffer.alloc(Math.min(MiB, total - done))
    })(),
  )

const only = <T>(sent: readonly unknown[], type: new (...args: never[]) => T): T[] =>
  sent.filter((command): command is T => command instanceof type)

const partSizes = (sent: readonly unknown[]): number[] =>
  only(sent, UploadPartCommand)
    .sort((a, b) => (a.input.PartNumber ?? 0) - (b.input.PartNumber ?? 0))
    .map((command) => (command.input.Body as Uint8Array).byteLength)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S3StorageDriver.putStream multipart (BK-021)', () => {
  it('uploads an unknown-length stream as a multipart upload when @aws-sdk/lib-storage is installed', async () => {
    const sent = mockSend()
    const driver = new S3StorageDriver(base)
    await driver.putStream('big.bin', unknownLength(11 * MiB), { contentType: 'application/octet-stream' })
    expect(only(sent, CreateMultipartUploadCommand)).toHaveLength(1)
    expect(partSizes(sent)).toEqual([5 * MiB, 5 * MiB, MiB])
    expect(only(sent, CompleteMultipartUploadCommand)).toHaveLength(1)
    expect(only(sent, PutObjectCommand)).toHaveLength(0)
  })

  it('applies the tenant-scoped key, the content type and the server-side encryption to the multipart upload', async () => {
    const sent = mockSend()
    const disk = new Disk('uploads', new S3StorageDriver({ ...base, serverSideEncryption: { kms: 'alias/files' } }), {
      scope: () => 'tenants/acme',
    })
    await disk.putStream('imports/big.csv', unknownLength(6 * MiB), { contentType: 'text/csv' })
    const create = only(sent, CreateMultipartUploadCommand)[0]!
    expect(create.input.Bucket).toBe('test-bucket')
    expect(create.input.Key).toBe('tenants/acme/imports/big.csv')
    expect(create.input.ContentType).toBe('text/csv')
    expect(create.input.ServerSideEncryption).toBe('aws:kms')
    expect(create.input.SSEKMSKeyId).toBe('alias/files')
    // Every part is written into the same upload, under the same scoped key.
    for (const part of only(sent, UploadPartCommand)) {
      expect(part.input.Key).toBe('tenants/acme/imports/big.csv')
      expect(part.input.UploadId).toBe('upload-1')
    }
    expect(only(sent, CompleteMultipartUploadCommand)[0]!.input.UploadId).toBe('upload-1')
  })

  it('aborts the upload and destroys the source when a part fails — no incomplete parts are left behind', async () => {
    const sent = mockSend((command) => {
      if (command instanceof UploadPartCommand) throw new Error('part rejected')
    })
    const source = unknownLength(11 * MiB)
    const driver = new S3StorageDriver(base)
    await expect(driver.putStream('big.bin', source, { contentType: 'application/octet-stream' })).rejects.toThrow('part rejected')
    const abort = only(sent, AbortMultipartUploadCommand)
    expect(abort).toHaveLength(1)
    expect(abort[0]!.input.UploadId).toBe('upload-1')
    expect(only(sent, CompleteMultipartUploadCommand)).toHaveLength(0)
    expect(source.destroyed).toBe(true)
  })

  it('honours partSizeBytes and queueSize from the driver options', async () => {
    const sent = mockSend()
    const driver = new S3StorageDriver({ ...base, partSizeBytes: 6 * MiB, queueSize: 1 })
    await driver.putStream('big.bin', unknownLength(13 * MiB), { contentType: 'application/octet-stream' })
    expect(partSizes(sent)).toEqual([6 * MiB, 6 * MiB, MiB])
  })

  it('reaches the driver through s3Disk, not the disk options', async () => {
    const sent = mockSend()
    const config = s3Disk({ bucket: 'test-bucket', region: 'us-east-1', credentials: base.credentials, partSizeBytes: 6 * MiB, queueSize: 2 })
    expect(Object.keys(config)).toEqual(['driver'])
    await new Disk('uploads', config.driver, { ...config, scope: null }).putStream('big.bin', unknownLength(13 * MiB), {
      contentType: 'application/octet-stream',
    })
    expect(partSizes(sent)).toEqual([6 * MiB, 6 * MiB, MiB])
  })

  it('lets a single call override the driver part size', async () => {
    const sent = mockSend()
    const driver = new S3StorageDriver({ ...base, partSizeBytes: 8 * MiB })
    await driver.putStream('big.bin', unknownLength(11 * MiB), { contentType: 'application/octet-stream', partSizeBytes: 5 * MiB })
    expect(partSizes(sent)).toEqual([5 * MiB, 5 * MiB, MiB])
  })

  it('refuses a part size below S3 minimum, at construction and per call', async () => {
    const sent = mockSend()
    expect(() => new S3StorageDriver({ ...base, partSizeBytes: S3_MIN_PART_SIZE_BYTES - 1 })).toThrow(RangeError)
    expect(() => new S3StorageDriver({ ...base, partSizeBytes: 5.5 })).toThrow(RangeError)
    expect(() => new S3StorageDriver({ ...base, queueSize: 0 })).toThrow(RangeError)
    const driver = new S3StorageDriver(base)
    await expect(
      driver.putStream('big.bin', unknownLength(MiB), { contentType: 'application/octet-stream', partSizeBytes: 1024 }),
    ).rejects.toThrow(/at least 5242880 bytes/)
    expect(sent).toHaveLength(0)
  })

  it('still sends a known-length stream as a single PutObject — multipart changes nothing there', async () => {
    const sent = mockSend()
    const driver = new S3StorageDriver(base)
    const body = Readable.from([Buffer.from('abcde')])
    await driver.putStream('a.txt', body, { contentType: 'text/plain', contentLength: 5 })
    expect(only(sent, PutObjectCommand)).toHaveLength(1)
    expect(only(sent, CreateMultipartUploadCommand)).toHaveLength(0)
    expect((sent[0] as PutObjectCommand).input.Body).toBe(body)
  })

  it('keeps the buffered single-request path when maxBytes is set, and still enforces the cap mid-stream', async () => {
    const sent = mockSend()
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    await disk.putStream('small.bin', unknownLength(2 * MiB), { contentType: 'application/octet-stream', maxBytes: 4 * MiB })
    expect(only(sent, PutObjectCommand)).toHaveLength(1)
    expect(only(sent, CreateMultipartUploadCommand)).toHaveLength(0)

    sent.length = 0
    const source = unknownLength(8 * MiB)
    await expect(
      disk.putStream('big.bin', source, { contentType: 'application/octet-stream', maxBytes: 4 * MiB }),
    ).rejects.toBeInstanceOf(StorageTooLargeError)
    expect(sent).toHaveLength(0)
    expect(source.destroyed).toBe(true)
  })
})
