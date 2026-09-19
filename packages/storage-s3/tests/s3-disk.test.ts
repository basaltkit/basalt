import { describe, expect, it } from 'vitest'
import { Disk, TemporaryUrlTtlTooLongError, StorageTenantRequiredError } from '@basaltkit/storage'
import { S3StorageDriver, s3Disk } from '../src/index.js'

const credentials = { accessKeyId: 'test', secretAccessKey: 'test' }

describe('s3Disk propagates every DiskOptions field (BK-015)', () => {
  it('keeps onMissingScope, maxTemporaryUrlTtl and maxTemporaryUploadUrlTtl next to the driver', () => {
    const scope = () => 'custom'
    const config = s3Disk({
      bucket: 'b',
      credentials,
      scope,
      onMissingScope: 'error',
      maxTemporaryUrlTtl: '1h',
      maxTemporaryUploadUrlTtl: '5m',
    })
    expect(config.driver).toBeInstanceOf(S3StorageDriver)
    expect(config).toMatchObject({
      scope,
      onMissingScope: 'error',
      maxTemporaryUrlTtl: '1h',
      maxTemporaryUploadUrlTtl: '5m',
    })
    // Disk options must not leak into the driver config, nor driver options into the disk.
    expect(config).not.toHaveProperty('bucket')
    expect(config).not.toHaveProperty('credentials')
  })

  it('omits disk options that were not passed (defaults stay in charge)', () => {
    const config = s3Disk({ bucket: 'b', credentials })
    expect(Object.keys(config)).toEqual(['driver'])
  })

  // storagePlugin builds `new Disk(name, config.driver, config)`; mirror that.
  const diskOf = (config: ReturnType<typeof s3Disk>) => new Disk('s', config.driver, config)

  it('maxTemporaryUrlTtl passed to s3Disk is enforced by the disk', async () => {
    const disk = diskOf(s3Disk({ bucket: 'b', credentials, scope: null, maxTemporaryUrlTtl: '1h' }))
    await expect(disk.temporaryUrl('r.pdf', '2h')).rejects.toBeInstanceOf(TemporaryUrlTtlTooLongError)
    await expect(disk.temporaryUrl('r.pdf', '30m')).resolves.toContain('X-Amz-Signature')
  })

  it("onMissingScope: 'error' passed to s3Disk fails closed without a tenant", async () => {
    const disk = diskOf(s3Disk({ bucket: 'b', credentials, onMissingScope: 'error' }))
    // No tenant in context: without the option the key would hit the bucket root.
    await expect(disk.temporaryUrl('tenants/victim/r.pdf', '5m')).rejects.toBeInstanceOf(StorageTenantRequiredError)
  })
})
