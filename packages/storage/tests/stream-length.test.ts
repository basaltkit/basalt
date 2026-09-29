import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Disk, type PutOptions, type PutStreamOptions, type StorageDriver } from '../src/index.js'

/**
 * Models a cloud backend's commit semantics (S3 `PutObject`, a GCS resumable
 * upload, an Azure block list): the object becomes visible only when the body
 * ENDS cleanly. A body that errors first is never committed.
 */
class CommitOnEndDriver implements StorageDriver {
  readonly name = 'commit-on-end'
  readonly files = new Map<string, Buffer>()
  /** Bytes the driver pulled off the source, per key — even for an upload that failed. */
  readonly received = new Map<string, number>()
  async put(path: string, content: Buffer | string, _options?: PutOptions): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
  }
  async putStream(path: string, source: Readable, _options: PutStreamOptions): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of source) {
      chunks.push(Buffer.from(chunk as Uint8Array))
      this.received.set(path, (this.received.get(path) ?? 0) + (chunk as Uint8Array).byteLength)
    }
    this.files.set(path, Buffer.concat(chunks))
  }
  async get(path: string): Promise<Buffer> {
    const buffer = this.files.get(path)
    if (!buffer) throw new Error('not found')
    return buffer
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async delete(path: string): Promise<boolean> {
    return this.files.delete(path)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix))
  }
  async disconnect(): Promise<void> {}
}

const setup = () => {
  const driver = new CommitOnEndDriver()
  return { driver, disk: new Disk('uploads', driver, { scope: null }) }
}

/** A source that records whether anything was ever read from it. */
const watched = (chunks: Buffer[]) => {
  const state = { reads: 0 }
  const source = Readable.from(
    (function* () {
      for (const chunk of chunks) {
        state.reads += 1
        yield chunk
      }
    })(),
  )
  return { source, state }
}

describe('Disk.putStream validates contentLength (audit: files/storage item 7)', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses contentLength %s before a single byte is read',
    async (contentLength) => {
      const { disk, driver } = setup()
      const { source, state } = watched([Buffer.from('abc')])
      await expect(disk.putStream('a.bin', source, { contentType: 'text/plain', contentLength })).rejects.toMatchObject({
        code: 'STORAGE_CONTENT_LENGTH_INVALID',
        status: 400,
      })
      expect(state.reads).toBe(0)
      expect(driver.files.size).toBe(0)
    },
  )

  it('fails when the body is SHORTER than declared — before the end reaches the backend, so nothing is committed', async () => {
    const { disk, driver } = setup()
    await expect(
      disk.putStream('a.bin', Readable.from([Buffer.from('abcde')]), { contentType: 'text/plain', contentLength: 10 }),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTENT_LENGTH_MISMATCH', status: 400 })
    expect(driver.received.get('a.bin')).toBe(5)
    expect(driver.files.has('a.bin')).toBe(false)
  })

  it('fails the moment the body passes the declared length, and destroys the source', async () => {
    const { disk, driver } = setup()
    const source = Readable.from([Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')])
    await expect(disk.putStream('a.bin', source, { contentType: 'text/plain', contentLength: 4 })).rejects.toMatchObject({
      code: 'STORAGE_CONTENT_LENGTH_MISMATCH',
    })
    // Only the first chunk got through: the second one is the one that crossed.
    expect(driver.received.get('a.bin')).toBe(3)
    expect(driver.files.has('a.bin')).toBe(false)
    expect(source.destroyed).toBe(true)
  })

  it('accepts a body of exactly the declared length (including zero)', async () => {
    const { disk, driver } = setup()
    await disk.putStream('a.bin', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), { contentType: 'text/plain', contentLength: 4 })
    await disk.putStream('empty.bin', Readable.from([]), { contentType: 'text/plain', contentLength: 0 })
    expect(driver.files.get('a.bin')?.toString()).toBe('abcd')
    expect(driver.files.get('empty.bin')?.byteLength).toBe(0)
  })

  it('verifies the fallback copy against the size the source reported', async () => {
    const source = new CommitOnEndDriver()
    const target = new CommitOnEndDriver()
    // stat() says 10 bytes, the stream delivers 3: an object replaced mid-copy.
    Object.assign(source, {
      stat: async () => ({ size: 10 }),
      getStream: async () => Readable.from([Buffer.from('abc')]),
    })
    const from = new Disk('a', source, { scope: null })
    const to = new Disk('b', target, { scope: null })
    await expect(from.copy('x', 'y', { disk: to })).rejects.toMatchObject({ code: 'STORAGE_CONTENT_LENGTH_MISMATCH' })
    expect(target.files.has('y')).toBe(false)
  })
})
