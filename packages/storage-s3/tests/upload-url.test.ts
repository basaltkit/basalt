import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Disk } from '@basaltkit/storage'
import { S3StorageDriver, s3Disk, type S3DriverOptions } from '../src/index.js'

const base = {
  bucket: 'test-bucket',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
} satisfies S3DriverOptions

const sha = createHash('sha256').update('hello').digest('base64')

/** Parses a presigned URL: query params + the signed-header list. */
const parse = (url: string) => {
  const parsed = new URL(url)
  return {
    parsed,
    signed: (parsed.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';'),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('S3 temporaryUploadUrl (real presigner, offline)', () => {
  it('signs Content-Type, Content-Length and the SHA-256 checksum as headers the client must send', async () => {
    const driver = new S3StorageDriver(base)
    const upload = await driver.temporaryUploadUrl('tenants/acme/a.png', 300_000, {
      contentType: 'image/png',
      contentLength: 1234,
      checksumSha256: sha,
    })
    const { parsed, signed } = parse(upload.url)
    expect(parsed.host + parsed.pathname).toBe('test-bucket.s3.us-east-1.amazonaws.com/tenants/acme/a.png')
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(parsed.searchParams.get('x-id')).toBe('PutObject')
    expect(signed).toEqual(expect.arrayContaining(['content-type', 'content-length', 'x-amz-checksum-sha256']))
    // Bound as headers, not hoisted into the query string (where the client could skip them).
    expect(parsed.searchParams.has('x-amz-checksum-sha256')).toBe(false)
    expect(upload.method).toBe('PUT')
    expect(upload.headers).toEqual({
      'Content-Type': 'image/png',
      'Content-Length': '1234',
      'x-amz-checksum-sha256': sha,
    })
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now() + 290_000)
  })

  it('always signs Content-Type even without length/checksum, and adds no SDK default checksum', async () => {
    const driver = new S3StorageDriver(base)
    const upload = await driver.temporaryUploadUrl('a.png', 60_000, { contentType: 'image/png' })
    const { parsed, signed } = parse(upload.url)
    expect(signed).toContain('content-type')
    expect(signed).not.toContain('content-length')
    expect(upload.headers).toEqual({ 'Content-Type': 'image/png' })
    // An SDK-computed CRC32 of an empty body would make every real upload fail.
    expect([...parsed.searchParams.keys()].some((k) => k.toLowerCase().startsWith('x-amz-checksum-crc'))).toBe(false)
    expect(signed.some((h) => h.startsWith('x-amz-checksum-crc') || h === 'x-amz-sdk-checksum-algorithm')).toBe(false)
  })

  it("signs SSE headers into presigned PUTs: 'AES256'", async () => {
    const driver = new S3StorageDriver({ ...base, serverSideEncryption: 'AES256' })
    const upload = await driver.temporaryUploadUrl('a.png', 60_000, { contentType: 'image/png' })
    const { signed } = parse(upload.url)
    expect(signed).toContain('x-amz-server-side-encryption')
    expect(upload.headers['x-amz-server-side-encryption']).toBe('AES256')
  })

  it('signs SSE-KMS headers into presigned PUTs: { kms }', async () => {
    const kms = 'arn:aws:kms:us-east-1:111122223333:key/abcd'
    const driver = new S3StorageDriver({ ...base, serverSideEncryption: { kms } })
    const upload = await driver.temporaryUploadUrl('a.png', 60_000, { contentType: 'image/png' })
    const { signed } = parse(upload.url)
    expect(signed).toEqual(
      expect.arrayContaining(['x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id']),
    )
    expect(upload.headers).toMatchObject({
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': kms,
    })
  })

  it('works end-to-end through a Disk built by s3Disk (tenant prefix + TTL cap)', async () => {
    const config = s3Disk({ ...base, maxTemporaryUploadUrlTtl: '10m' })
    const disk = new Disk('uploads', config.driver, config)
    await expect(disk.temporaryUploadUrl('a.png', { expiresIn: '20m', contentType: 'image/png' })).rejects.toMatchObject({
      code: 'STORAGE_TEMPORARY_URL_TTL',
    })
    const upload = await disk.temporaryUploadUrl('a.png', { expiresIn: '5m', contentType: 'image/png' })
    expect(upload.key).toBe('a.png')
    expect(parse(upload.url).parsed.pathname).toBe('/a.png')
  })
})

describe('S3 server-side encryption on put (mocked client)', () => {
  const captureSend = () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
    return () => (send.mock.calls[0]?.[0] as PutObjectCommand).input
  }

  it('sends no SSE headers by default (bucket-default encryption applies)', async () => {
    const input = captureSend()
    await new S3StorageDriver(base).put('a.txt', 'x', { contentType: 'text/plain' })
    expect(input()).not.toHaveProperty('ServerSideEncryption')
    expect(input()).not.toHaveProperty('SSEKMSKeyId')
  })

  it("applies 'AES256' to puts", async () => {
    const input = captureSend()
    await new S3StorageDriver({ ...base, serverSideEncryption: 'AES256' }).put('a.txt', 'x')
    expect(input()).toMatchObject({ Bucket: 'test-bucket', Key: 'a.txt', ServerSideEncryption: 'AES256' })
    expect(input()).not.toHaveProperty('SSEKMSKeyId')
  })

  it('applies { kms } to puts', async () => {
    const input = captureSend()
    await new S3StorageDriver({ ...base, serverSideEncryption: { kms: 'alias/app' } }).put('a.txt', 'x')
    expect(input()).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'alias/app' })
  })

  it('s3Disk forwards serverSideEncryption to the driver, not to the disk', async () => {
    const input = captureSend()
    const config = s3Disk({ ...base, serverSideEncryption: 'AES256' })
    expect(config).not.toHaveProperty('serverSideEncryption')
    await config.driver.put('a.txt', 'x')
    expect(input()).toMatchObject({ ServerSideEncryption: 'AES256' })
  })
})
