import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Disk, StorageSigningEndpointInvalidError } from '@basaltkit/storage'
import { S3StorageDriver, s3Disk, type S3DriverOptions } from '../src/index.js'

const base = {
  bucket: 'uploads',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  endpoint: 'http://minio:9000',
} satisfies S3DriverOptions

const sha = createHash('sha256').update('hello').digest('base64')
const upload = { expiresIn: '5m', contentType: 'image/png', contentLength: 1234, checksumSha256: sha } as const

describe('S3 pre-signed URLs for an alternate endpoint (BK-005 phase 2)', () => {
  it('signs the upload URL for the override host, keeping the signed headers', async () => {
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    const signed = await disk.temporaryUploadUrl('a.png', { ...upload, endpoint: 'https://files.example.com' })
    const url = new URL(signed.url)
    expect(url.origin).toBe('https://files.example.com')
    // Path style is kept, so the same bucket/key is addressed under the new host.
    expect(url.pathname).toBe('/uploads/a.png')
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-type', 'content-length', 'x-amz-checksum-sha256']),
    )
    expect(signed.headers).toEqual({
      'Content-Type': 'image/png',
      'Content-Length': '1234',
      'x-amz-checksum-sha256': sha,
    })
  })

  it('signs a download URL for the override host', async () => {
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    const url = new URL(await disk.temporaryUrl('a.png', '5m', { endpoint: 'http://minio.internal:9000' }))
    expect(url.origin).toBe('http://minio.internal:9000')
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })

  it('a driver-level signingEndpoint is the default, and a per-call endpoint wins over it', async () => {
    const disk = new Disk('uploads', new S3StorageDriver({ ...base, signingEndpoint: 'https://cdn.example.com' }), { scope: null })
    expect(new URL(await disk.temporaryUrl('a.png', '5m')).origin).toBe('https://cdn.example.com')
    expect(new URL((await disk.temporaryUploadUrl('a.png', upload)).url).origin).toBe('https://cdn.example.com')
    expect(new URL(await disk.temporaryUrl('a.png', '5m', { endpoint: 'http://minio:9000' })).origin).toBe('http://minio:9000')
  })

  it('s3Disk forwards signingEndpoint to the driver, not to the disk', () => {
    const config = s3Disk({ bucket: 'b', credentials: base.credentials, signingEndpoint: 'https://cdn.example.com' })
    expect(Object.keys(config)).toEqual(['driver'])
  })

  it('leaves the driver endpoint alone when no override is given', async () => {
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    expect(new URL(await disk.temporaryUrl('a.png', '5m')).origin).toBe('http://minio:9000')
    expect(new URL((await disk.temporaryUploadUrl('a.png', upload)).url).origin).toBe('http://minio:9000')
  })

  it.each([
    ['not a URL', 'minio:9000'],
    ['a non-http scheme', 'ftp://files.example.com'],
    // Built at runtime so secret scanners do not flag this fake credential.
    ['embedded credentials', ['https://key', 'secret@files.example.com'].join(':')],
    ['a query string', 'https://files.example.com?x=1'],
  ])('refuses %s as a signing endpoint', async (_label, endpoint) => {
    const disk = new Disk('uploads', new S3StorageDriver(base), { scope: null })
    await expect(disk.temporaryUploadUrl('a.png', { ...upload, endpoint })).rejects.toBeInstanceOf(
      StorageSigningEndpointInvalidError,
    )
    await expect(disk.temporaryUrl('a.png', '5m', { endpoint })).rejects.toMatchObject({
      code: 'STORAGE_SIGNING_ENDPOINT_INVALID',
      status: 400,
    })
  })

  it('still validates the key and the tenant scope with an override', async () => {
    const disk = new Disk('uploads', new S3StorageDriver(base), { onMissingScope: 'error' })
    await expect(
      disk.temporaryUploadUrl('a.png', { ...upload, endpoint: 'https://files.example.com' }),
    ).rejects.toMatchObject({ code: 'STORAGE_TENANT_REQUIRED' })
  })
})
