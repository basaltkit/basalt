import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The optional peer is NOT installed.
 *
 * `@aws-sdk/lib-storage` IS a devDependency here (the multipart tests drive the
 * real `Upload`), so absence is simulated: the module factory throws exactly
 * what Node throws for a package it cannot resolve — an `Error` carrying
 * `code: 'ERR_MODULE_NOT_FOUND'` — which is what the driver's lazy loader
 * treats as "not installed". `vi.resetModules()` plus a fresh dynamic import of
 * the driver clears the loader's one-shot cache between cases.
 */
const missing = () => {
  const error = new Error("Cannot find package '@aws-sdk/lib-storage'") as Error & { code: string }
  error.code = 'ERR_MODULE_NOT_FOUND'
  throw error
}

/** Every message in an error's `cause` chain, as one string. */
const causes = (error: unknown): string => {
  const parts: string[] = []
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    parts.push(String((current as { message?: unknown }).message ?? ''))
    current = (current as { cause?: unknown }).cause
  }
  return parts.join(' | ')
}

async function driverWithoutLibStorage(broken?: () => never) {
  vi.resetModules()
  vi.doMock('@aws-sdk/lib-storage', broken ?? missing)
  const [{ S3StorageDriver }, { S3Client }] = await Promise.all([import('../src/index.js'), import('@aws-sdk/client-s3')])
  const sent: unknown[] = []
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
    sent.push(command)
    return {} as never
  })
  return {
    driver: new S3StorageDriver({ bucket: 'test-bucket', region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }),
    sent,
  }
}

afterEach(() => {
  vi.doUnmock('@aws-sdk/lib-storage')
  vi.restoreAllMocks()
})

describe('S3StorageDriver.putStream without @aws-sdk/lib-storage (BK-021)', () => {
  it('still refuses an unknown-length stream, and names the package that would allow it', async () => {
    const { driver, sent } = await driverWithoutLibStorage()
    const source = Readable.from([Buffer.from('x')])
    await expect(driver.putStream('a.txt', source, { contentType: 'text/plain' })).rejects.toMatchObject({
      code: 'STORAGE_STREAM_LENGTH_REQUIRED',
      status: 400,
      message: expect.stringContaining('@aws-sdk/lib-storage'),
    })
    expect(sent).toHaveLength(0)
    expect(source.destroyed).toBe(true)
  })

  it('leaves the known-length and capped paths untouched', async () => {
    const { driver, sent } = await driverWithoutLibStorage()
    await driver.putStream('a.txt', Readable.from([Buffer.from('abcde')]), { contentType: 'text/plain', contentLength: 5 })
    await driver.putStream('b.txt', Readable.from([Buffer.from('ab')]), { contentType: 'text/plain', maxBytes: 1024 })
    expect(sent).toHaveLength(2)
  })

  it('surfaces a broken install instead of degrading it into "length required"', async () => {
    const { driver } = await driverWithoutLibStorage(() => {
      throw new Error('boom: broken install')
    })
    const error: unknown = await driver.putStream('a.txt', Readable.from(['x']), { contentType: 'text/plain' }).catch((reason) => reason)
    expect((error as { code?: string }).code).not.toBe('STORAGE_STREAM_LENGTH_REQUIRED')
    // The loader (vitest, like a bundler) wraps the module's own failure.
    expect(causes(error)).toContain('boom: broken install')
  })
})
