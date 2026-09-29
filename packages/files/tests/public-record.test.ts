import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Container, runWithContext } from '@basaltkit/core'
import { toErrorResponse } from '@basaltkit/http'
import type { PutStreamOptions } from '@basaltkit/storage'
import {
  FILES,
  Files,
  MemoryFileStore,
  fileRoutes,
  toPublicFile,
  type FileRecord,
  type FileRoutesOptions,
} from '../src/index.js'
import { FakeDriver, fakeDisk } from './fixtures.js'

const pdf = Buffer.from('%PDF-1.7\n%%EOF\n')

async function seeded() {
  const { disk, driver } = fakeDisk()
  const store = new MemoryFileStore()
  const files = new Files({ disk, store })
  const record = await files.upload(pdf, {
    name: 'contract.pdf',
    contentType: 'application/pdf',
    tenantId: 'acme',
    uploadedBy: 'u1',
    metadata: { folder: 'legal' },
  })
  await files.markScanned(record.id, { clean: false, detail: 'Eicar-Test-Signature (engine 1.2, /var/scan/tmp/abc)' }, 'acme')
  return { files, store, driver, record: (await files.get(record.id, 'acme'))! }
}

function call(files: Files, options: FileRoutesOptions, method: string, url: string, input: Record<string, unknown> = {}) {
  const container = new Container()
  container.singleton(FILES, () => files)
  const route = fileRoutes(options).find((r) => r.method === method && r.url === url)!
  const state: { status?: number; payload?: unknown } = {}
  const reply = {
    code: (status: number) => ((state.status = status), reply),
    send: (payload: unknown) => ((state.payload = payload), payload),
    header: () => reply,
  }
  return runWithContext({ container, user: { id: 'u1' }, tenant: { id: 'acme' } } as never, async () => {
    const out = await route.handler({ reply, ...input } as never)
    return { out, state }
  })
}

describe('fileRoutes answers with a public projection of the record (audit: files/storage item 7)', () => {
  it('GET /files/:id keeps path, checksum, uploadedBy, tenantId and the scan detail server-side', async () => {
    const { files, record } = await seeded()
    const { out } = await call(files, {}, 'GET', '/files/:id', { params: { id: record.id } })
    expect(out).toEqual({
      id: record.id,
      name: 'contract.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      createdAt: record.createdAt,
      scannedAt: record.scannedAt,
      scan: { clean: false },
      metadata: { folder: 'legal' },
    })
    const json = JSON.stringify(out)
    for (const secret of [record.path, record.checksum, 'Eicar', '/var/scan', 'u1', 'acme']) expect(json).not.toContain(secret)
    // The record itself is untouched — the projection is a copy.
    expect(record.path).toBe(`files/${record.id}`)
    expect((record.metadata?.['scan'] as { detail?: string }).detail).toContain('Eicar')
  })

  it('GET /files lists the same projection', async () => {
    const { files, record } = await seeded()
    const { out } = await call(files, {}, 'GET', '/files')
    expect(out).toEqual([toPublicFile(record)])
    expect(JSON.stringify(out)).not.toContain(record.checksum)
  })

  it('POST /files answers with the projection of what it stored', async () => {
    const { files } = await seeded()
    const body = {
      files: (async function* () {
        yield { filename: 'b.pdf', declaredType: 'application/pdf', stream: Readable.from([pdf]) }
      })(),
    }
    const { out, state } = await call(files, { upload: { maxBytes: 1024 } }, 'POST', '/files', { body })
    expect(state.status).toBe(201)
    const [created] = out as Record<string, unknown>[]
    expect(created).toMatchObject({ name: 'b.pdf', size: pdf.length })
    expect(created).not.toHaveProperty('path')
    expect(created).not.toHaveProperty('checksum')
    expect(created).not.toHaveProperty('uploadedBy')
  })

  it('`present` replaces the projection on every route — an app can expose more, or less', async () => {
    const { files, record } = await seeded()
    const present = (file: FileRecord) => ({ id: file.id, name: file.name, uploadedBy: file.uploadedBy ?? null })
    expect((await call(files, { present }, 'GET', '/files/:id', { params: { id: record.id } })).out).toEqual({
      id: record.id,
      name: 'contract.pdf',
      uploadedBy: 'u1',
    })
    expect((await call(files, { present }, 'GET', '/files')).out).toEqual([{ id: record.id, name: 'contract.pdf', uploadedBy: 'u1' }])
  })

  it('a verdict-less scan entry is not invented into a verdict', () => {
    const base: FileRecord = { id: 'f', tenantId: 't', name: 'n', contentType: 'text/plain', size: 1, path: 'p', checksum: 'c', createdAt: 1 }
    expect(toPublicFile(base)).toEqual({ id: 'f', name: 'n', contentType: 'text/plain', size: 1, createdAt: 1 })
    expect(toPublicFile({ ...base, metadata: { scan: 'weird' } })).toEqual({ id: 'f', name: 'n', contentType: 'text/plain', size: 1, createdAt: 1 })
  })
})

/** Trusts the declared length, as S3 `PutObject` does: it stores exactly `contentLength` bytes. */
class LengthTrustingDriver extends FakeDriver {
  override async putStream(path: string, source: Readable, options: PutStreamOptions): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = Buffer.concat(chunks)
    this.files.set(path, options.contentLength === undefined ? body : body.subarray(0, options.contentLength))
  }
}

describe('files.upload validates the declared contentLength (audit: files/storage item 7)', () => {
  const setup = (driver = new FakeDriver()) => {
    const { Disk } = diskModule
    const disk = new Disk('uploads', driver, { onMissingScope: 'root' })
    const store = new MemoryFileStore()
    return { driver, store, files: new Files({ disk, store }) }
  }

  it.each([-1, 2.5, Number.NaN])('refuses contentLength %s with a 400 before reading the body', async (contentLength) => {
    const { files, driver } = setup()
    let reads = 0
    const source = Readable.from(
      (function* () {
        reads += 1
        yield pdf
      })(),
    )
    const error = await files
      .upload(source, { name: 'a.pdf', contentType: 'application/pdf', tenantId: 'acme', contentLength })
      .catch((e: unknown) => e)
    expect(toErrorResponse(error)).toMatchObject({ status: 400, body: { error: { code: 'STORAGE_CONTENT_LENGTH_INVALID' } } })
    expect(reads).toBe(0)
    expect(driver.files.size).toBe(0)
  })

  it('refuses a declared length past maxSize with 413 before reading the body', async () => {
    const { disk } = fakeDisk()
    const files = new Files({ disk, validate: { maxSize: 10 } })
    await expect(
      files.upload(Readable.from([Buffer.alloc(4)]), { name: 'a', contentType: 'text/plain', tenantId: 'acme', contentLength: 11 }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })

  it('streaming: a body shorter or longer than declared leaves neither a record nor an object', async () => {
    const { files, driver, store } = setup(new LengthTrustingDriver())
    for (const contentLength of [pdf.length + 5, pdf.length - 5]) {
      await expect(
        files.upload(Readable.from([pdf]), { name: 'a.pdf', contentType: 'application/pdf', tenantId: 'acme', contentLength }),
      ).rejects.toMatchObject({ code: 'STORAGE_CONTENT_LENGTH_MISMATCH', status: 400 })
    }
    expect(driver.files.size).toBe(0)
    expect(await store.list('acme')).toEqual([])
  })

  it('streaming: an honest declared length is stored as-is, and the record matches the object', async () => {
    const { files, driver } = setup(new LengthTrustingDriver())
    const record = await files.upload(Readable.from([pdf]), {
      name: 'a.pdf',
      contentType: 'application/pdf',
      tenantId: 'acme',
      contentLength: pdf.length,
    })
    expect(record.size).toBe(pdf.length)
    expect(driver.files.get(`tenants/acme/${record.path}`)?.length).toBe(pdf.length)
  })

  it('buffered: a declared length the bytes contradict is refused too, and nothing is written', async () => {
    const { disk, driver } = fakeDisk()
    // A custom checkQuota forces the buffered path.
    const files = new Files({ disk, checkQuota: () => undefined })
    await expect(
      files.upload(Readable.from([pdf]), { name: 'a.pdf', contentType: 'application/pdf', tenantId: 'acme', contentLength: 3 }),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTENT_LENGTH_MISMATCH' })
    await expect(
      files.upload(pdf, { name: 'a.pdf', contentType: 'application/pdf', tenantId: 'acme', contentLength: pdf.length + 1 }),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTENT_LENGTH_MISMATCH' })
    expect(driver.files.size).toBe(0)
  })
})

const diskModule = await import('@basaltkit/storage')
