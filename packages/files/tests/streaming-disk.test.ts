import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Disk, type PutOptions, type StorageDriver } from '@basaltkit/storage'
import {
  FileInfectedError,
  FileNotFoundError,
  FileNotScannedError,
  FileTooLargeError,
  FileTypeMismatchError,
  Files,
  SNIFF_WINDOW,
  type FilesOptions,
} from '../src/index.js'
import { corpus, fakeDisk } from './fixtures.js'

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const setup = (options: Partial<FilesOptions> = {}) => {
  const { driver, disk } = fakeDisk()
  return { driver, files: new Files({ disk, ...options }) }
}

/** The driver key a record lands on: the tenant scope prefix plus the record path. */
const key = (record: { path: string }, tenant = 'acme') => `tenants/${tenant}/${record.path}`

const read = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

/** A driver with no optional capabilities: forces the buffered path. */
class BufferOnlyDriver implements StorageDriver {
  readonly name = 'buffer-only'
  readonly files = new Map<string, Buffer>()
  async put(path: string, content: Buffer | string, _options?: PutOptions): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
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

describe('BK-019 · files.upload streams to the disk', () => {
  const content = Buffer.concat([corpus.pdf, Buffer.alloc(200_000, 7)])
  const chunks = [content.subarray(0, SNIFF_WINDOW + 10), content.subarray(SNIFF_WINDOW + 10, 120_000), content.subarray(120_000)]

  it('hands the body to putStream in pieces instead of one buffer', async () => {
    const { files, driver } = setup({ validate: { sniff: true, maxSize: 1_000_000 } })
    const record = await files.upload(Readable.from(chunks), { name: 'a.pdf', contentType: 'application/pdf', tenantId: 'acme' })
    expect(record.size).toBe(content.length)
    expect(record.checksum).toBe(sha256(content))
    expect(record.contentType).toBe('application/pdf')
    expect(driver.files.get(key(record))).toEqual(content)
    // More than one chunk reached the driver: the upload was never one buffer.
    expect(driver.streamed.get(key(record))?.length).toBeGreaterThan(1)
    expect(driver.streamed.get(key(record))?.reduce((a, b) => a + b, 0)).toBe(content.length)
  })

  it('passes the declared contentLength and the size cap through to the driver', async () => {
    const { files, driver } = setup({ validate: { maxSize: 4096 } })
    const record = await files.upload(Readable.from([Buffer.alloc(16)]), {
      name: 'a.bin',
      contentType: 'application/octet-stream',
      tenantId: 'acme',
      contentLength: 16,
    })
    expect(driver.streamOptions.get(key(record))).toMatchObject({
      contentType: 'application/octet-stream',
      contentLength: 16,
      maxBytes: 4096,
    })
  })

  it('deletes the partial object when the stream passes maxSize mid-upload', async () => {
    const { files, driver } = setup({ validate: { maxSize: 100 } })
    const source = Readable.from(Array.from({ length: 10 }, () => Buffer.alloc(40)))
    await expect(files.upload(source, { name: 'big', contentType: 'text/plain', tenantId: 'acme' })).rejects.toBeInstanceOf(
      FileTooLargeError,
    )
    // The driver did receive bytes before the limit was hit; none are left.
    expect(driver.streamed.size).toBe(1)
    expect(driver.files.size).toBe(0)
    expect(source.destroyed).toBe(true)
    expect(await files.list('acme')).toEqual([])
  })

  it('rejects a disguised stream from the sniff window, before the disk is touched', async () => {
    const { files, driver } = setup({ validate: { sniff: true } })
    const head = Buffer.concat([corpus.html, Buffer.alloc(SNIFF_WINDOW)])
    await expect(
      files.upload(Readable.from([head, Buffer.alloc(4096)]), { name: 'x.pdf', contentType: 'application/pdf', tenantId: 'acme' }),
    ).rejects.toBeInstanceOf(FileTypeMismatchError)
    expect(driver.streamed.size).toBe(0)
    expect(driver.files.size).toBe(0)
  })

  it('aborts mid-stream on the built-in quota and leaves nothing behind', async () => {
    const { files, driver } = setup({ maxTotalBytes: 25 })
    await files.upload(Readable.from([Buffer.alloc(20)]), { name: 'a', contentType: 'text/plain', tenantId: 'acme' })
    await expect(
      files.upload(Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), { name: 'b', contentType: 'text/plain', tenantId: 'acme' }),
    ).rejects.toMatchObject({ code: 'FILE_QUOTA_EXCEEDED' })
    expect(driver.files.size).toBe(1)
    expect(await files.list('acme')).toHaveLength(1)
  })

  it('falls back to disk.put on a driver without putStream — same record', async () => {
    const driver = new BufferOnlyDriver()
    const files = new Files({ disk: new Disk('uploads', driver) })
    const record = await files.upload(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), {
      name: 'a.txt',
      contentType: 'text/plain',
      tenantId: 'acme',
    })
    expect(record.size).toBe(4)
    expect(record.checksum).toBe(sha256(Buffer.from('abcd')))
    expect(driver.files.get('tenants/acme/files/' + record.id)?.toString()).toBe('abcd')
  })

  it('falls back to the buffered path when a custom checkQuota needs the size up front', async () => {
    const sizes: number[] = []
    const { files, driver } = setup({ checkQuota: (_tenant, size) => void sizes.push(size) })
    const record = await files.upload(Readable.from([Buffer.alloc(8)]), { name: 'a', contentType: 'text/plain', tenantId: 'acme' })
    expect(sizes).toEqual([8])
    expect(driver.streamed.size).toBe(0)
    expect(driver.files.get(key(record))?.length).toBe(8)
  })

  it('falls back to the buffered path when maxSize is unbounded and no length is declared', async () => {
    const { files, driver } = setup({ validate: { maxSize: Infinity } })
    const record = await files.upload(Readable.from([Buffer.alloc(8)]), { name: 'a', contentType: 'text/plain', tenantId: 'acme' })
    expect(driver.streamed.size).toBe(0)
    expect(record.size).toBe(8)
    // ...but a declared contentLength is enough to stream it after all.
    const streamed = await files.upload(Readable.from([Buffer.alloc(8)]), {
      name: 'b',
      contentType: 'text/plain',
      tenantId: 'acme',
      contentLength: 8,
    })
    expect(driver.streamed.has(key(streamed))).toBe(true)
  })

  it('a plain Uint8Array still takes the buffered path', async () => {
    const { files, driver } = setup()
    const record = await files.upload(new Uint8Array([1, 2, 3]), { name: 'a', contentType: 'application/octet-stream', tenantId: 'acme' })
    expect(driver.streamed.size).toBe(0)
    expect(record.size).toBe(3)
  })
})

describe('BK-019 · files.downloadStream', () => {
  it('streams the bytes back with the record', async () => {
    const { files } = setup()
    const record = await files.upload(Buffer.from('hello stream'), { name: 'a.txt', contentType: 'text/plain', tenantId: 'acme' })
    const { record: found, stream } = await files.downloadStream(record.id, 'acme')
    expect(found.id).toBe(record.id)
    expect((await read(stream)).toString()).toBe('hello stream')
  })

  it('throws FileNotFoundError for an unknown id and for another tenant', async () => {
    const { files } = setup()
    const record = await files.upload(Buffer.from('x'), { name: 'a', contentType: 'text/plain', tenantId: 'acme' })
    await expect(files.downloadStream('missing', 'acme')).rejects.toBeInstanceOf(FileNotFoundError)
    await expect(files.downloadStream(record.id, 'globex')).rejects.toBeInstanceOf(FileNotFoundError)
  })

  it('honours the quarantine gate, exactly as download() does', async () => {
    const { files } = setup({ requireScan: true })
    const record = await files.upload(Buffer.from('%PDF-1.7'), { name: 'a.pdf', contentType: 'application/pdf', tenantId: 'acme' })
    await expect(files.downloadStream(record.id, 'acme')).rejects.toBeInstanceOf(FileNotScannedError)

    // The scanner itself must be able to read the bytes it is about to judge.
    const { stream } = await files.downloadStream(record.id, 'acme', { bypassQuarantine: true })
    expect((await read(stream)).toString()).toBe('%PDF-1.7')

    await files.markScanned(record.id, { clean: false }, 'acme')
    await expect(files.downloadStream(record.id, 'acme')).rejects.toBeInstanceOf(FileInfectedError)

    await files.markScanned(record.id, { clean: true }, 'acme')
    const clean = await files.downloadStream(record.id, 'acme')
    expect((await read(clean.stream)).toString()).toBe('%PDF-1.7')
  })

  it('reports STORAGE_GET_STREAM_UNSUPPORTED on a driver that cannot stream', async () => {
    const files = new Files({ disk: new Disk('uploads', new BufferOnlyDriver()) })
    const record = await files.upload(Buffer.from('x'), { name: 'a', contentType: 'text/plain', tenantId: 'acme' })
    await expect(files.downloadStream(record.id, 'acme')).rejects.toMatchObject({ code: 'STORAGE_GET_STREAM_UNSUPPORTED' })
  })
})
