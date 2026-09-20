import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { importItem, type DriveSinkInput } from '@basaltkit/drives'
import { GOOGLE_SIMPLE_UPLOAD_MAX_BYTES } from '../src/index.js'
import { CDN_HOST, DOC_MIME, FOLDER_MIME } from './google-server.js'
import { connect, harness, readAll } from './helpers.js'

const TREE = [
  { id: 'root-folder', name: 'Finance', mimeType: FOLDER_MIME, parents: [] },
  { id: 'sub-folder', name: '2026', mimeType: FOLDER_MIME, parents: ['root-folder'] },
  { id: 'top', name: 'summary.pdf', content: 'summary bytes', parents: ['root-folder'] },
  { id: 'deep', name: 'invoice.pdf', content: 'invoice bytes', parents: ['sub-folder'] },
  { id: 'elsewhere', name: 'private.pdf', content: 'other folder bytes', parents: ['other-folder'] },
]

describe('listing', () => {
  it('enumerates the whole account when the connection has no root', async () => {
    const h = harness({ server: { files: TREE, pageSize: 2 } })
    const view = await connect(h)

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await h.drives.listItems(view.id, cursor !== undefined ? { cursor } : {})
      seen.push(...page.items.map((item) => item.externalId))
      cursor = page.cursor
    } while (cursor !== undefined)

    expect(seen.sort()).toEqual(['deep', 'elsewhere', 'root-folder', 'sub-folder', 'top'])
  })

  it('walks the SUBTREE of a scoped connection, not just its top level', async () => {
    const h = harness({ server: { files: TREE, pageSize: 2 } })
    const view = await connect(h, { rootId: 'root-folder' })

    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await h.drives.listItems(view.id, cursor !== undefined ? { cursor } : {})
      seen.push(...page.items.map((item) => item.externalId))
      cursor = page.cursor
    } while (cursor !== undefined)

    // Drive has NO recursive query. `'root-folder' in parents` returns `top`
    // and `sub-folder` and stops — so an adapter that stopped there would
    // backfill a scoped connection with its top level only, and the account-
    // wide change feed would then deliver the subfolder's files as if they had
    // appeared from nowhere. The walk is what makes the two agree.
    expect(seen.sort()).toEqual(['deep', 'sub-folder', 'top'])
    expect(seen).not.toContain('elsewhere')
  })

  it('lists one level only under listMode: children', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 }, provider: { listMode: 'children' } })
    const view = await connect(h, { rootId: 'root-folder' })

    const page = await h.drives.listItems(view.id)
    expect(page.items.map((item) => item.externalId).sort()).toEqual(['sub-folder', 'top'])
    expect(page.cursor).toBeUndefined()
  })

  it('refuses a folder id that is not a Drive id, rather than escaping it into `q`', async () => {
    const h = harness({ server: { files: TREE } })
    const view = await connect(h)
    // `q` is a query language with string literals in it. A missed quote in an
    // escape widens a listing the tenant deliberately scoped, so the adapter
    // validates instead of escaping.
    await expect(h.drives.listItems(view.id, { folderId: "root' or name contains 'x" })).rejects.toThrow(
      /not a Google Drive file id/,
    )
  })

  it('never lists trashed files', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)
    h.google.trash('top')

    const page = await h.drives.listItems(view.id)
    expect(page.items.map((i) => i.externalId)).not.toContain('top')
    const q = new URL(h.google.requests.at(-1)!.url).searchParams.get('q')
    expect(q).toContain('trashed = false')
  })
})

describe('metadata mapping', () => {
  it('maps a binary file: md5 checksum, head revision, web link', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)

    const item = (await h.drives.getItem(view.id, 'top'))!
    expect(item.name).toBe('summary.pdf')
    expect(item.kind).toBe('file')
    // Labelled honestly: it IS an MD5 of the bytes, and it is comparable with
    // anyone else's MD5 of the same bytes.
    expect(item.checksum).toEqual({ algorithm: 'md5', value: expect.stringMatching(/^[0-9a-f]{32}$/) })
    // `headRevisionId`, not Drive's `version` counter — the counter moves on a
    // rename, and re-downloading a file because someone renamed it is a bill.
    expect(item.version).toMatch(/^rev-/)
    expect(item.externalUrl).toBe('https://drive.google.com/file/d/top/view')
    expect(item.parentId).toBe('root-folder')
    expect(item.size).toBe(Buffer.byteLength('summary bytes'))
    expect(item.exportOnly).toBeUndefined()
  })

  it('marks a Google-native document exportOnly, with no checksum and no size', async () => {
    const h = harness({
      server: { files: [{ id: 'doc1', name: 'Contract', mimeType: DOC_MIME, parents: [] }], pageSize: 50 },
    })
    const view = await connect(h)

    const item = (await h.drives.getItem(view.id, 'doc1'))!
    expect(item.exportOnly).toBe(true)
    // The absence IS the signal: Docs/Sheets/Slides publish neither, because
    // there are no stored bytes to describe.
    expect(item.checksum).toBeUndefined()
    expect(item.size).toBeUndefined()
    expect(item.raw?.['mimeType']).toBe(DOC_MIME)
  })

  it('returns null for a file that is gone, rather than throwing', async () => {
    const h = harness({ server: { files: TREE } })
    const view = await connect(h)
    // An import job for a file someone deleted mid-sync is not a failure worth
    // retrying.
    expect(await h.drives.getItem(view.id, 'no-such-file')).toBeNull()
  })

  it('has no path, because Drive is a graph and a path would be a fabrication', async () => {
    const h = harness({ server: { files: TREE } })
    const view = await connect(h)
    expect((await h.drives.getItem(view.id, 'deep'))!.path).toBeUndefined()
  })
})

describe('download', () => {
  it('follows the 302 to googleusercontent and streams the bytes', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)
    const item = (await h.drives.getItem(view.id, 'deep'))!

    const content = await h.drives.download(view.id, item)
    expect(await readAll(content.stream)).toBe('invoice bytes')

    // The redirect really happened, and the guarded fetch re-validated the CDN
    // host before a byte moved.
    const hosts = h.google.requests.map((r) => new URL(r.url).hostname)
    expect(hosts).toContain('www.googleapis.com')
    expect(hosts).toContain(CDN_HOST)
  })

  it('refuses a redirect to a look-alike host', async () => {
    // The exact attack the `.suffix` rule exists for: a naive `endsWith`
    // check would wave this through.
    const h = harness({ server: { files: TREE, redirectHost: 'evilgoogleusercontent.com' } })
    const view = await connect(h)
    const item = (await h.drives.getItem(view.id, 'deep'))!

    await expect(h.drives.download(view.id, item)).rejects.toMatchObject({ code: 'DRIVE_HOST_NOT_ALLOWED' })
  })

  it('refuses a redirect to the bare parent domain', async () => {
    const h = harness({ server: { files: TREE, redirectHost: 'googleusercontent.com' } })
    const view = await connect(h)
    const item = (await h.drives.getItem(view.id, 'deep'))!

    // `.googleusercontent.com` allows subdomains ONLY. The bare parent is
    // never a CDN host and allowing it would widen the guard for nothing.
    await expect(h.drives.download(view.id, item)).rejects.toMatchObject({ code: 'DRIVE_HOST_NOT_ALLOWED' })
  })

  it('never puts a signed download URL in an error', async () => {
    const h = harness({ server: { files: TREE, redirectHost: 'evilgoogleusercontent.com' } })
    const view = await connect(h)
    const item = (await h.drives.getItem(view.id, 'deep'))!

    const error = await h.drives.download(view.id, item).catch((e: unknown) => e)
    const serialised = JSON.stringify({
      message: (error as Error).message,
      details: (error as { details?: unknown }).details,
    })
    // A Drive download URL is itself a bearer credential for the file. The
    // error names the host and nothing else — no path, no `sig`.
    expect(serialised).toContain('evilgoogleusercontent.com')
    expect(serialised).not.toContain('sig=')
    expect(serialised).not.toContain('/download/')
  })

  it('serves bytes directly when Google does not redirect', async () => {
    const h = harness({ server: { files: TREE, directDownload: true, pageSize: 50 } })
    const view = await connect(h)
    const item = (await h.drives.getItem(view.id, 'top'))!

    const content = await h.drives.download(view.id, item)
    expect(await readAll(content.stream)).toBe('summary bytes')
    expect(content.size).toBe(Buffer.byteLength('summary bytes'))
  })

  it('refuses a Google-native document instead of exporting to a format nobody asked for', async () => {
    const h = harness({
      server: { files: [{ id: 'doc1', name: 'Contract', mimeType: DOC_MIME, parents: [] }], pageSize: 50 },
    })
    const view = await connect(h)
    const item = (await h.drives.getItem(view.id, 'doc1'))!

    await expect(h.drives.download(view.id, item)).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' })
    // And it refuses BEFORE the request, so Drive's own 403 never happens.
    expect(h.google.requests.some((r) => r.url.includes('alt=media'))).toBe(false)
  })

  it('skips an export-only item on import rather than failing the job for ever', async () => {
    const h = harness({
      server: { files: [{ id: 'doc1', name: 'Contract', mimeType: DOC_MIME, parents: [] }], pageSize: 50 },
    })
    const view = await connect(h)
    const item = (await h.drives.getItem(view.id, 'doc1'))!
    const sink = async (_input: DriveSinkInput) => ({ targetId: 'never' })

    // Without this, every Doc and Sheet in a tenant's Drive becomes a
    // permanently failing import job, re-enqueued by every sync because a
    // failure never reaches the ledger.
    const outcome = await importItem(h.drives, view.id, item, sink)
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-content' })

    // Under `reference` nothing is downloaded, so the app still gets the item
    // and can run its own export.
    const referenced = await importItem(h.drives, view.id, item, sink, { strategy: 'reference' })
    expect(referenced.status).toBe('imported')
  })
})

describe('upload', () => {
  it('streams a multipart body and returns the created file', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)

    const created = await h.drives.upload(view.id, {
      name: 'report.txt',
      contentType: 'text/plain',
      content: Readable.from([Buffer.from('hello '), Buffer.from('world')]),
      folderId: 'root-folder',
    })

    expect(created.name).toBe('report.txt')
    const request = h.google.requests.find((r) => r.url.includes('/upload/drive/v3/files'))!
    expect(request.headers['content-type']).toMatch(/^multipart\/related; boundary=basalt-/)
    expect(request.body).toContain('"parents":["root-folder"]')
    expect(request.body).toContain('hello world')
    const fetched = await h.drives.download(view.id, created)
    expect(await readAll(fetched.stream)).toBe('hello world')
  })

  it('refuses a file over the 5 MB simple-upload ceiling up front', async () => {
    const h = harness({ server: { files: TREE } })
    const view = await connect(h)

    await expect(
      h.drives.upload(view.id, {
        name: 'big.bin',
        contentType: 'application/octet-stream',
        content: Readable.from([Buffer.alloc(16)]),
        size: GOOGLE_SIMPLE_UPLOAD_MAX_BYTES + 1,
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_CONTENT_TOO_LARGE' })
    // Refused before the bytes were sent, not after.
    expect(h.google.requests.some((r) => r.url.includes('/upload/'))).toBe(false)
  })

  it('caps a source that lies about its size, mid-stream', async () => {
    const h = harness({ server: { files: TREE }, provider: { uploadMaxBytes: 8 } })
    const view = await connect(h)

    await expect(
      h.drives.upload(view.id, {
        name: 'liar.bin',
        contentType: 'application/octet-stream',
        // No declared size at all, and far more bytes than the cap allows.
        content: Readable.from([Buffer.alloc(64, 1)]),
      }),
    ).rejects.toThrow()
  })
})
