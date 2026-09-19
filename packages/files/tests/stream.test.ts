import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { FileTooLargeError, FileTypeMismatchError, FileTypeNotAllowedError, Files, SNIFF_WINDOW, type FileValidation } from '../src/index.js'
import { corpus, fakeDisk } from './fixtures.js'

function setup(validate?: FileValidation) {
  const { driver, disk } = fakeDisk()
  return { driver, files: new Files({ disk, ...(validate ? { validate } : {}) }) }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** An async generator that records how far it was pulled and whether it was closed early. */
function tracked(chunks: Buffer[]) {
  const state = { pulled: 0, closed: false }
  async function* gen(): AsyncGenerator<Uint8Array> {
    try {
      for (const chunk of chunks) {
        state.pulled++
        yield chunk
      }
    } finally {
      state.closed = true
    }
  }
  return { iterable: gen(), state }
}

describe('BK-006 · upload accepts streams', () => {
  const content = Buffer.concat([corpus.pdf, Buffer.alloc(10_000, 7)])
  const chunks = [content.subarray(0, 3), content.subarray(3, 5000), content.subarray(5000)]

  it.each([
    ['Node Readable', () => Readable.from(chunks)],
    ['AsyncIterable<Uint8Array>', () => tracked(chunks).iterable],
    ['web ReadableStream', () => ReadableStream.from(chunks.map((c) => new Uint8Array(c)))],
  ])('%s: stores the bytes, computes size and checksum while streaming', async (_, source) => {
    const { files, driver } = setup({ sniff: true, allowedTypes: ['application/pdf'] })
    const record = await files.upload(source(), { name: 'a.pdf', contentType: 'application/pdf', tenantId: 'acme' })
    expect(record.size).toBe(content.length)
    expect(record.checksum).toBe(sha256(content))
    expect(record.contentType).toBe('application/pdf')
    expect([...driver.files.values()][0]).toEqual(content)
  })

  it('accepts string chunks (a Readable with an encoding)', async () => {
    const { files, driver } = setup()
    const record = await files.upload(Readable.from(['hello ', 'world']), { name: 'a.txt', contentType: 'text/plain', tenantId: 'acme' })
    expect([...driver.files.values()][0]?.toString()).toBe('hello world')
  })

  it('enforces maxSize WHILE streaming: stops pulling, closes the source, writes nothing', async () => {
    const { files, driver } = setup({ maxSize: 100 })
    const { iterable, state } = tracked(Array.from({ length: 50 }, () => Buffer.alloc(40)))
    const error = await files.upload(iterable, { name: 'big', contentType: 'text/plain', tenantId: 'acme' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FileTooLargeError)
    expect(state.pulled).toBe(3)
    expect(state.closed).toBe(true)
    expect(driver.files.size).toBe(0)
  })

  it('destroys a Node Readable and cancels a web ReadableStream past the limit', async () => {
    const { files } = setup({ maxSize: 10 })
    const readable = Readable.from([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)])
    await expect(files.upload(readable, { name: 'x', contentType: 'text/plain', tenantId: 'acme' })).rejects.toBeInstanceOf(FileTooLargeError)
    expect(readable.destroyed).toBe(true)

    let cancelled = false
    const web = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(files.upload(web, { name: 'x', contentType: 'text/plain', tenantId: 'acme' })).rejects.toBeInstanceOf(FileTooLargeError)
    expect(cancelled).toBe(true)
  })

  it('sniffs on the first bytes and rejects a disguised stream before reading the rest', async () => {
    const { files, driver } = setup({ sniff: true })
    const head = Buffer.concat([corpus.html, Buffer.alloc(SNIFF_WINDOW)])
    const { iterable, state } = tracked([head, ...Array.from({ length: 20 }, () => Buffer.alloc(1024))])
    await expect(files.upload(iterable, { name: 'x.pdf', contentType: 'application/pdf', tenantId: 'acme' })).rejects.toBeInstanceOf(
      FileTypeMismatchError,
    )
    expect(state.pulled).toBe(1)
    expect(state.closed).toBe(true)
    expect(driver.files.size).toBe(0)
  })

  it('sniffs a short stream once it ends', async () => {
    const { files } = setup({ sniff: true })
    await expect(
      files.upload(Readable.from([corpus.exe]), { name: 'x.jpg', contentType: 'image/jpeg', tenantId: 'acme' }),
    ).rejects.toBeInstanceOf(FileTypeMismatchError)
  })

  it('without sniffing, a disallowed declared type is refused before a single byte is read', async () => {
    const { files } = setup({ allowedTypes: ['image/*'] })
    const { iterable, state } = tracked([corpus.pdf])
    await expect(files.upload(iterable, { name: 'x', contentType: 'application/pdf', tenantId: 'acme' })).rejects.toBeInstanceOf(
      FileTypeNotAllowedError,
    )
    expect(state.pulled).toBe(0)
  })

  it('a stream counts against the tenant quota by its streamed size', async () => {
    const { disk } = fakeDisk()
    const files = new Files({ disk, maxTotalBytes: 25 })
    await files.upload(Readable.from([Buffer.alloc(20)]), { name: 'a', contentType: 'text/plain', tenantId: 'acme' })
    await expect(
      files.upload(Readable.from([Buffer.alloc(10)]), { name: 'b', contentType: 'text/plain', tenantId: 'acme' }),
    ).rejects.toMatchObject({ code: 'FILE_QUOTA_EXCEEDED' })
  })

  it('still accepts a plain Uint8Array', async () => {
    const { files } = setup()
    const record = await files.upload(new Uint8Array([1, 2, 3]), { name: 'a', contentType: 'application/octet-stream', tenantId: 'acme' })
    expect(record.size).toBe(3)
  })
})
