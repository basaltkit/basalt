import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Disk, TemporaryUploadUrlUnsupportedError } from '@basaltkit/storage'
import { AzureBlobStorageDriver, type AzureBlobLike, type AzureContainerLike } from '../src/index.js'

type SasOptions = Parameters<AzureBlobLike['generateSasUrl']>[0]

/** Records every SAS the driver asks for. */
class RecordingContainer implements AzureContainerLike {
  readonly sas: { path: string; options: SasOptions }[] = []
  getBlockBlobClient(path: string): AzureBlobLike {
    const sas = this.sas
    return {
      async uploadData() {},
      async downloadToBuffer() {
        return Buffer.alloc(0)
      },
      async exists() {
        return false
      },
      async deleteIfExists() {
        return { succeeded: false }
      },
      async generateSasUrl(options) {
        sas.push({ path, options })
        return `https://azure.test/${path}?sp=${options.permissions}&se=${options.expiresOn.toISOString()}`
      },
    }
  }
  async *listBlobsFlat(): AsyncIterable<{ name: string }> {}
}

const make = () => {
  const client = new RecordingContainer()
  return { client, driver: new AzureBlobStorageDriver({ container: 'c', client }) }
}

describe('Azure temporaryUploadUrl (BK-005)', () => {
  it('mints a short-lived create/write SAS and returns the headers Put Blob needs', async () => {
    const { client, driver } = make()
    const before = Date.now()
    const upload = await driver.temporaryUploadUrl('tenants/acme/a.png', 300_000, {
      contentType: 'image/png',
      contentLength: 1234,
    })
    expect(client.sas).toHaveLength(1)
    const { path, options } = client.sas[0]!
    expect(path).toBe('tenants/acme/a.png')
    expect(options.permissions).toBe('cw') // no read, list or delete
    expect(options.expiresOn.getTime()).toBeGreaterThanOrEqual(before + 300_000)
    expect(options.expiresOn.getTime()).toBeLessThanOrEqual(Date.now() + 300_000)
    expect(options).not.toHaveProperty('contentDisposition')
    expect(upload).toMatchObject({
      url: expect.stringContaining('azure.test/tenants/acme/a.png?sp=cw'),
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/png', 'Content-Length': '1234' },
    })
    expect(upload.expiresAt).toEqual(options.expiresOn)
  })

  it('caps the SAS lifetime even when called directly (Azure has no native maximum)', async () => {
    const { driver } = make()
    const DAY = 24 * 60 * 60 * 1000
    await expect(driver.temporaryUploadUrl('a.png', 8 * DAY, { contentType: 'image/png' })).rejects.toMatchObject({
      code: 'STORAGE_TEMPORARY_URL_TTL',
    })
    await expect(driver.temporaryUploadUrl('a.png', 0, { contentType: 'image/png' })).rejects.toMatchObject({
      code: 'STORAGE_TEMPORARY_URL_TTL',
    })
  })

  it('refuses checksumSha256: a SAS cannot bind it and Put Blob has no SHA-256 header', async () => {
    const { client, driver } = make()
    const checksumSha256 = createHash('sha256').update('x').digest('base64')
    await expect(driver.temporaryUploadUrl('a.png', 60_000, { contentType: 'image/png', checksumSha256 })).rejects.toBeInstanceOf(
      TemporaryUploadUrlUnsupportedError,
    )
    expect(client.sas).toHaveLength(0)
  })

  it('works through a Disk (tenant prefix + default 1h cap)', async () => {
    const { driver } = make()
    const disk = new Disk('azure', driver, { scope: () => 'tenants/acme' })
    await expect(disk.temporaryUploadUrl('a.png', { expiresIn: '2h', contentType: 'image/png' })).rejects.toMatchObject({
      code: 'STORAGE_TEMPORARY_URL_TTL',
    })
    const upload = await disk.temporaryUploadUrl('a.png', { expiresIn: '5m', contentType: 'image/png' })
    expect(upload.key).toBe('tenants/acme/a.png')
    expect(upload.url).toContain('azure.test/tenants/acme/a.png')
  })
})

describe('Azure refuses a signing-endpoint override (BK-005 phase 2)', () => {
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
