import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { dropboxContentHash } from '../src/content-hash.js'
import { apiArg, dropboxPath } from '../src/metadata.js'
import { connect, harness, readAll } from './helpers.js'

const FILES = [
  { id: 'id:a', path: '/Finance/invoice.pdf', content: 'invoice bytes' },
  { id: 'id:b', path: '/Finance/receipt.pdf', content: 'receipt bytes' },
  { id: 'id:c', path: '/Finance/notes.txt', content: 'notes' },
]

describe('listing', () => {
  it('pages a folder on the list_folder cursor', async () => {
    const h = harness({ server: { files: FILES, pageSize: 2 } })
    const view = await connect(h)

    const first = await h.drives.listItems(view.id, { folderId: '/Finance' })
    expect(first.items).toHaveLength(2)
    expect(first.cursor).toBeTruthy()

    const second = await h.drives.listItems(view.id, { cursor: first.cursor as string })
    expect(second.items).toHaveLength(1)
    // `has_more` is false, so no cursor is handed back: a pagination cursor
    // and a change-feed cursor are different contracts even though Dropbox
    // spells them the same way.
    expect(second.cursor).toBeUndefined()

    const continued = h.dropbox.requests.filter((r) => r.url.endsWith('/list_folder/continue'))
    expect(continued).toHaveLength(1)
  })

  it('sends the root as the empty string, not as "/"', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    await h.drives.listItems(view.id)

    const listed = h.dropbox.requests.find((r) => r.url.endsWith('/files/list_folder'))!
    expect(JSON.parse(listed.body)).toMatchObject({ path: '', recursive: true })
  })

  it('confines a connection to its root folder', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, { rootId: '/Finance' })
    await h.drives.listItems(view.id)

    const listed = h.dropbox.requests.find((r) => r.url.endsWith('/files/list_folder'))!
    expect(JSON.parse(listed.body).path).toBe('/Finance')
  })

  it('maps rev to version and content_hash to a clearly-labelled checksum', async () => {
    const h = harness({ server: { files: [FILES[0]!], pageSize: 10 } })
    const view = await connect(h)
    const page = await h.drives.listItems(view.id)
    const item = page.items[0]!

    expect(item.externalId).toBe('id:a')
    expect(item.name).toBe('invoice.pdf')
    expect(item.path).toBe('/Finance/invoice.pdf')
    expect(item.version).toMatch(/^0150/)
    // NOT labelled sha256: it is a block-tree digest and is not comparable
    // with another provider's SHA-256 of the same bytes.
    expect(item.checksum).toEqual({
      algorithm: 'dropboxContentHash',
      value: dropboxContentHash(Buffer.from('invoice bytes', 'utf8')),
    })
    // Dropbox states no media type at all — which the contract already treats
    // as untrusted, so the bytes decide.
    expect(item.contentType).toBeUndefined()
  })
})

describe('metadata', () => {
  it('reads one item by id', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const item = await h.drives.getItem(view.id, 'id:b')
    expect(item?.name).toBe('receipt.pdf')
    expect(JSON.parse(h.dropbox.requests.at(-1)!.body)).toEqual({ path: 'id:b' })
  })

  it('answers null for a file that is gone, rather than failing the job', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    // Dropbox answers 409 `path/not_found/` — an endpoint error, not an HTTP
    // 404 — and the contract says a missing item is `null`.
    await expect(h.drives.getItem(view.id, 'id:gone')).resolves.toBeNull()
  })
})

describe('download', () => {
  it('streams the bytes with the argument in the Dropbox-API-Arg header', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const content = await h.drives.download(view.id, { externalId: 'id:a', name: 'invoice.pdf', kind: 'file' })

    expect(await readAll(content.stream)).toBe('invoice bytes')
    const request = h.dropbox.requests.at(-1)!
    expect(request.url).toBe('https://content.dropboxapi.com/2/files/download')
    expect(JSON.parse(request.headers['dropbox-api-arg']!)).toEqual({ path: 'id:a' })
    // The body slot is reserved for the file, so the argument cannot go there.
    expect(request.body).toBe('')
    expect(request.headers['accept']).toBe('*/*')
  })

  it('reports the size from Dropbox-API-Result', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const content = await h.drives.download(view.id, { externalId: 'id:a', name: 'invoice.pdf', kind: 'file' })
    expect(content.size).toBe('invoice bytes'.length)
    content.stream.destroy()
  })

  it('refuses an export-only item instead of failing obscurely later', async () => {
    const h = harness({
      server: { files: [{ id: 'id:p', path: '/Paper/doc.paper', content: '', isDownloadable: false }] },
    })
    const view = await connect(h)
    const page = await h.drives.listItems(view.id)
    expect(page.items[0]!.exportOnly).toBe(true)
    await expect(h.drives.download(view.id, page.items[0]!)).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' })
  })

  it('abandons a download that exceeds the byte cap mid-stream', async () => {
    const h = harness({ server: { files: [{ id: 'id:big', path: '/big.bin', content: 'x'.repeat(5000) }] } })
    const view = await connect(h)
    const drives = h.drives as unknown as { options: { maxBytes?: number } }
    drives.options.maxBytes = 100

    const content = await h.drives.download(view.id, { externalId: 'id:big', name: 'big.bin', kind: 'file' })
    await expect(readAll(content.stream)).rejects.toMatchObject({ code: 'DRIVE_CONTENT_TOO_LARGE' })
  })
})

describe('upload', () => {
  it('streams a single-shot upload with the octet-stream content type', async () => {
    const h = harness({ server: { files: [] } })
    const view = await connect(h)
    const item = await h.drives.upload(view.id, {
      name: 'report.pdf',
      contentType: 'application/pdf',
      content: Readable.from([Buffer.from('report bytes')]),
      folderId: '/Finance',
    })

    expect(item.name).toBe('report.pdf')
    const request = h.dropbox.requests.at(-1)!
    expect(request.url).toBe('https://content.dropboxapi.com/2/files/upload')
    expect(request.headers['content-type']).toBe('application/octet-stream')
    expect(JSON.parse(request.headers['dropbox-api-arg']!)).toMatchObject({
      path: '/Finance/report.pdf',
      mode: 'add',
      autorename: true,
    })
    expect(request.body).toBe('report bytes')
  })

  it('refuses a file over the single-shot limit up front, without sending it', async () => {
    const h = harness({ server: { files: [] }, provider: { uploadMaxBytes: 64 } })
    const view = await connect(h)
    const before = h.dropbox.requests.length

    await expect(
      h.drives.upload(view.id, {
        name: 'huge.bin',
        contentType: 'application/octet-stream',
        content: Readable.from([Buffer.alloc(10)]),
        size: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_CONTENT_TOO_LARGE' })
    expect(h.dropbox.requests.length).toBe(before)
  })

  it('caps a source that understates its size, mid-stream', async () => {
    const h = harness({ server: { files: [] }, provider: { uploadMaxBytes: 16 } })
    const view = await connect(h)
    await expect(
      h.drives.upload(view.id, {
        name: 'lying.bin',
        contentType: 'application/octet-stream',
        // No declared size at all: the only defence is counting the bytes.
        content: Readable.from([Buffer.alloc(64, 1)]),
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_CONTENT_TOO_LARGE' })
  })

  it('strips path separators out of a filename', async () => {
    const h = harness({ server: { files: [] } })
    const view = await connect(h)
    await h.drives.upload(view.id, {
      name: '../../etc/passwd',
      contentType: 'text/plain',
      content: Readable.from([Buffer.from('x')]),
      folderId: '/Finance',
    })
    const arg = JSON.parse(h.dropbox.requests.at(-1)!.headers['dropbox-api-arg']!) as { path: string }
    // The destination stays exactly one level under the folder we chose: no
    // separator survives the name, and the leading dot-run is gone, so there is
    // no way to climb out of the connection's root.
    expect(arg.path.startsWith('/Finance/')).toBe(true)
    expect(arg.path.slice('/Finance/'.length)).not.toContain('/')
    expect(arg.path).not.toContain('/..')
  })
})

describe('Dropbox-API-Arg encoding', () => {
  it('escapes non-ASCII, because the argument travels in an HTTP header', () => {
    // A Portuguese filename is the common case, not an edge one.
    expect(apiArg({ path: '/Finanças/relatório.pdf' })).toBe(
      '{"path":"/Finan\\u00e7as/relat\\u00f3rio.pdf"}',
    )
    expect(apiArg({ path: '/a/b' })).toBe('{"path":"/a/b"}')
  })

  it('escapes a newline so a filename cannot split the header', () => {
    expect(apiArg({ path: '/a\nX-Evil: 1' })).not.toContain('\n')
  })
})

describe('path normalisation', () => {
  it('accepts the three spellings Dropbox actually takes', () => {
    expect(dropboxPath(undefined)).toBe('')
    expect(dropboxPath('')).toBe('')
    expect(dropboxPath('/')).toBe('')
    expect(dropboxPath('id:abc')).toBe('id:abc')
    expect(dropboxPath('ns:123/Shared')).toBe('ns:123/Shared')
    expect(dropboxPath('/Finance')).toBe('/Finance')
    expect(dropboxPath('Finance/2026')).toBe('/Finance/2026')
  })
})
