import { describe, expect, it } from 'vitest'
import { Disk } from '../src/index.js'
import type { StorageDriver, TemporaryUrlOptions } from '../src/driver.js'

/**
 * S-3 (review 2026-08-b): signed download URLs default to
 * `Content-Disposition: attachment`. A client-declared text/html or SVG
 * object fetched top-level from the bucket/CDN then downloads instead of
 * rendering — killing the stored-XSS vector — while <img>/embedded uses are
 * unaffected (disposition does not apply to subresource rendering).
 */
const recordingDriver = () => {
  const calls: { path: string; options?: TemporaryUrlOptions }[] = []
  const driver: StorageDriver = {
    name: 'recording',
    async put() {},
    async get() {
      return Buffer.from('')
    },
    async exists() {
      return true
    },
    async delete() {
      return true
    },
    async list() {
      return []
    },
    async temporaryUrl(path, _expiresInMs, options) {
      calls.push({ path, ...(options ? { options } : {}) })
      return `https://signed.test/${path}`
    },
    async disconnect() {},
  }
  return { driver, calls }
}

describe('Disk.temporaryUrl disposition (secure by default)', () => {
  it('defaults to attachment', async () => {
    const { driver, calls } = recordingDriver()
    const disk = new Disk('test', driver, { scope: null })
    await disk.temporaryUrl('report.html', '15m')
    expect(calls[0]?.options?.disposition).toBe('attachment')
  })

  it('inline is a deliberate opt-out', async () => {
    const { driver, calls } = recordingDriver()
    const disk = new Disk('test', driver, { scope: null })
    await disk.temporaryUrl('preview.pdf', '15m', { disposition: 'inline' })
    expect(calls[0]?.options?.disposition).toBe('inline')
  })
})

describe('S3 presign carries the disposition (real presigner, offline)', () => {
  it('attachment by default, inline on opt-out', async () => {
    const { S3StorageDriver } = await import('../src/drivers/s3.js')
    const driver = new S3StorageDriver({
      bucket: 'test-bucket',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    } as never)
    const url = await driver.temporaryUrl!('tenants/acme/x.html', 60_000, { disposition: 'attachment' })
    expect(url).toContain('response-content-disposition=attachment')
    const inline = await driver.temporaryUrl!('tenants/acme/x.pdf', 60_000, { disposition: 'inline' })
    expect(inline).toContain('response-content-disposition=inline')
  })
})
