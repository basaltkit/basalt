import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { Disk, StorageTooLargeError } from '@basaltkit/storage'
import { S3StorageDriver, type S3DriverOptions } from '../src/index.js'

const MiB = 1024 * 1024

const base = {
  bucket: 'test-bucket',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
} satisfies S3DriverOptions

/**
 * A fake S3 transport that behaves like the service where it matters here: it
 * answers the multipart handshake, and it CONSUMES every request body (a
 * stream is read to the end, as the HTTP handler would), rejecting when the
 * body errors. `@aws-sdk/lib-storage` is the real one.
 */
function fakeS3() {
  const sent: unknown[] = []
  const bodySizes: number[] = []
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    sent.push(command)
    const body = (command as { input?: { Body?: unknown } }).input?.Body
    if (body instanceof Readable) {
      let size = 0
      for await (const chunk of body) size += (chunk as Uint8Array).byteLength
      bodySizes.push(size)
    } else if (body instanceof Uint8Array) {
      bodySizes.push(body.byteLength)
    } else if (typeof body === 'string') {
      bodySizes.push(Buffer.byteLength(body))
    }
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload-1' } as never
    if (command instanceof UploadPartCommand) return { ETag: `"part-${command.input.PartNumber}"` } as never
    return {} as never
  })
  return { sent, bodySizes }
}

/** `total` bytes in 1 MiB chunks, with no declared length. */
const unknownLength = (total: number): Readable =>
  Readable.from(
    (function* () {
      for (let done = 0; done < total; done += MiB) yield Buffer.alloc(Math.min(MiB, total - done))
    })(),
  )

const only = <T>(sent: readonly unknown[], type: new (...args: never[]) => T): T[] =>
  sent.filter((command): command is T => command instanceof type)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S3 unknown-length streams never buffer up to maxBytes (audit: files/storage item 7)', () => {
  it('uploads multipart under a cap: no request body ever exceeds one part', async () => {
    const { sent, bodySizes } = fakeS3()
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    // What `files.upload()` sends without a Content-Length: the stream plus the
    // file size cap (25 MiB by default).
    await disk.putStream('big.bin', unknownLength(11 * MiB), { contentType: 'application/octet-stream', maxBytes: 25 * MiB })
    expect(only(sent, CreateMultipartUploadCommand)).toHaveLength(1)
    expect(only(sent, CompleteMultipartUploadCommand)).toHaveLength(1)
    // It used to be ONE PutObject carrying an 11 MiB Buffer collected in memory.
    expect(only(sent, PutObjectCommand)).toHaveLength(0)
    expect(Math.max(...bodySizes)).toBeLessThanOrEqual(5 * MiB)
    expect(bodySizes.reduce((a, b) => a + b, 0)).toBe(11 * MiB)
  })

  it('a body smaller than one part is a single PutObject of that body — still never more than a part in memory', async () => {
    const { sent } = fakeS3()
    const driver = new S3StorageDriver(base)
    await driver.putStream('small.bin', unknownLength(2 * MiB), { contentType: 'application/octet-stream', maxBytes: 25 * MiB })
    expect(only(sent, PutObjectCommand)).toHaveLength(1)
    expect(only(sent, CreateMultipartUploadCommand)).toHaveLength(0)
  })

  it('still enforces the cap mid-stream, and completes nothing', async () => {
    const { sent } = fakeS3()
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    const source = unknownLength(16 * MiB)
    await expect(
      disk.putStream('big.bin', source, { contentType: 'application/octet-stream', maxBytes: 7 * MiB }),
    ).rejects.toBeInstanceOf(StorageTooLargeError)
    expect(only(sent, CompleteMultipartUploadCommand)).toHaveLength(0)
    expect(source.destroyed).toBe(true)
  })

  it('a declared length that the body does not match fails before S3 completes the PutObject', async () => {
    const { sent } = fakeS3()
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    await expect(
      disk.putStream('a.bin', Readable.from([Buffer.from('abcde')]), { contentType: 'text/plain', contentLength: 10 }),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTENT_LENGTH_MISMATCH' })
    expect(only(sent, PutObjectCommand)).toHaveLength(1)
  })
})
