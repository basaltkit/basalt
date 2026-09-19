import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Disk, TemporaryUploadUrlUnsupportedError } from '@basaltkit/storage'
import { GcsStorageDriver, type GcsBucketLike, type GcsFileLike, type GcsSignedUrlConfig } from '../src/index.js'

/** Records every signed-URL config the driver asks for. */
class RecordingBucket implements GcsBucketLike {
  readonly signed: { path: string; config: GcsSignedUrlConfig }[] = []
  file(path: string): GcsFileLike {
    const signed = this.signed
    return {
      async save() {},
      async download(): Promise<[Buffer]> {
        return [Buffer.alloc(0)]
      },
      async exists(): Promise<[boolean]> {
        return [false]
      },
      async delete() {},
      async getSignedUrl(config): Promise<[string]> {
        signed.push({ path, config })
        return [`https://gcs.test/${path}?action=${config.action}`]
      },
    }
  }
  async getFiles(): Promise<[{ name: string }[]]> {
    return [[]]
  }
}

const make = () => {
  const client = new RecordingBucket()
  return { client, driver: new GcsStorageDriver({ bucket: 'b', client }) }
}

describe('GCS temporaryUploadUrl (BK-005)', () => {
  it('signs a v4 write URL bound to the content type and exact length', async () => {
    const { client, driver } = make()
    const before = Date.now()
    const upload = await driver.temporaryUploadUrl('tenants/acme/a.png', 300_000, {
      contentType: 'image/png',
      contentLength: 1234,
    })
    const { path, config } = client.signed[0]!
    expect(path).toBe('tenants/acme/a.png')
    expect(config).toMatchObject({
      version: 'v4',
      action: 'write',
      contentType: 'image/png',
      extensionHeaders: { 'x-goog-content-length-range': '1234,1234' },
    })
    expect(config.expires).toBeGreaterThanOrEqual(before + 300_000)
    expect(upload).toMatchObject({
      url: 'https://gcs.test/tenants/acme/a.png?action=write',
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'x-goog-content-length-range': '1234,1234' },
    })
    expect(upload.expiresAt.getTime()).toBe(config.expires)
  })

  it('binds only the content type when no length is declared', async () => {
    const { client, driver } = make()
    const upload = await driver.temporaryUploadUrl('a.png', 60_000, { contentType: 'image/png' })
    expect(client.signed[0]!.config).not.toHaveProperty('extensionHeaders')
    expect(upload.headers).toEqual({ 'Content-Type': 'image/png' })
  })

  it('refuses checksumSha256: GCS verifies MD5/CRC32C only', async () => {
    const { client, driver } = make()
    const checksumSha256 = createHash('sha256').update('x').digest('base64')
    await expect(driver.temporaryUploadUrl('a.png', 60_000, { contentType: 'image/png', checksumSha256 })).rejects.toBeInstanceOf(
      TemporaryUploadUrlUnsupportedError,
    )
    expect(client.signed).toHaveLength(0)
  })

  it('works through a Disk (tenant prefix + TTL cap)', async () => {
    const { driver } = make()
    const disk = new Disk('gcs', driver, { scope: () => 'tenants/acme', maxTemporaryUploadUrlTtl: '10m' })
    await expect(disk.temporaryUploadUrl('a.png', { expiresIn: '11m', contentType: 'image/png' })).rejects.toMatchObject({
      code: 'STORAGE_TEMPORARY_URL_TTL',
    })
    const upload = await disk.temporaryUploadUrl('a.png', { expiresIn: '5m', contentType: 'image/png' })
    expect(upload.key).toBe('tenants/acme/a.png')
  })
})

describe('GCS refuses a signing-endpoint override (BK-005 phase 2)', () => {
  it('reports it as unsupported instead of signing for the wrong host', async () => {
    const { driver } = make()
    await expect(
      driver.temporaryUploadUrl('a.png', 60_000, { contentType: 'image/png', endpoint: 'https://files.example.com' }),
    ).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_URL_UNSUPPORTED' })
    await expect(driver.temporaryUrl('a.png', 60_000, { endpoint: 'https://files.example.com' })).rejects.toMatchObject({
      code: 'STORAGE_TEMPORARY_URL_UNSUPPORTED',
    })
  })
})
