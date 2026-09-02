import { describe, expect, it } from 'vitest'
import { S3StorageDriver } from '../src/index.js'

/**
 * Moved here from @basaltkit/storage when the driver was extracted: the core no
 * longer knows S3, so the package that owns the driver owns its tests.
 */

describe('S3 presign carries the disposition (real presigner, offline)', () => {
  it('attachment by default, inline on opt-out', async () => {
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
