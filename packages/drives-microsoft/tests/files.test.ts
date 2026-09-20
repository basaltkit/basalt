import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { importItem } from '@basaltkit/drives'
import { microsoftRoot } from '../src/index.js'
import { connect, harness, readAll, wireText } from './helpers.js'

const FILES = [
  { id: '01AAA', name: 'invoice.pdf', content: 'invoice bytes', quickXorHash: 'aXhkS0xNTk8=' },
  { id: '01BBB', name: 'report.txt', content: 'report bytes', sha256: 'ABCDEF0123456789' },
  { id: '01CCC', name: 'notes.one', content: '', isPackage: true },
]

describe('listing', () => {
  it('reads a folder and maps Graph metadata onto the contract', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)

    const page = await h.drives.listItems(view.id)
    const invoice = page.items.find((item) => item.externalId === '01AAA')!

    expect(invoice.name).toBe('invoice.pdf')
    expect(invoice.kind).toBe('file')
    expect(invoice.path).toBe('/invoice.pdf')
    expect(invoice.contentType).toBe('text/plain')
    expect(invoice.size).toBe('invoice bytes'.length)
    // `cTag`, not `eTag`: Graph bumps eTag on a rename too, and the dedup
    // ledger prefers `version`, so eTag would re-download renamed files.
    expect(invoice.version).toMatch(/^"c:/)
    expect(invoice.externalUrl).toContain('https://acme-my.sharepoint.com/')
    // A OneNote notebook is in the namespace but has no bytes.
    expect(page.items.find((item) => item.externalId === '01CCC')?.exportOnly).toBe(true)
  })

  it('labels the checksum by what Graph actually published, per account type', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    const items = (await h.drives.listItems(view.id)).items

    // Business / SharePoint: a Microsoft block-XOR construction in base64,
    // comparable with nothing else anywhere.
    expect(items.find((i) => i.externalId === '01AAA')?.checksum).toEqual({
      algorithm: 'quickXorHash',
      value: 'aXhkS0xNTk8=',
    })
    // Personal OneDrive: a real digest, lowercased to match the contract.
    expect(items.find((i) => i.externalId === '01BBB')?.checksum).toEqual({
      algorithm: 'sha256',
      value: 'abcdef0123456789',
    })
  })

  it('keeps `@odata.nextLink` inside an opaque cursor instead of handing a URL to the engine', async () => {
    const h = harness({ server: { files: FILES, pageSize: 2 } })
    const view = await connect(h)

    const first = await h.drives.listItems(view.id)
    expect(first.items).toHaveLength(2)
    expect(first.cursor).toBeDefined()
    // The engine persists this in the connection row and returns it in
    // `DriveSyncResult`. A raw provider URL there leaks Graph's paging state
    // into an app's database and invites somebody to fetch it.
    expect(first.cursor).not.toContain('https://')
    expect(first.cursor).toMatch(/^basalt\.msgraph\.list:/)

    const second = await h.drives.listItems(view.id, { cursor: first.cursor })
    expect(second.items).toHaveLength(1)
    expect(second.cursor).toBeUndefined()
    // …and following it really did go back to Graph.
    expect(h.graph.requests.some((r) => r.url.includes('$skiptoken=2'))).toBe(true)
  })

  it('refuses a cursor that points anywhere but Graph, before opening a socket', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const forged = `basalt.msgraph.list:${Buffer.from('https://evil.test/steal').toString('base64url')}`

    // The guarded fetch would refuse this a moment later on the allowlist; the
    // adapter refuses it first, and names the real reason.
    await expect(h.drives.listItems(view.id, { cursor: forged })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
    expect(h.graph.requests.some((r) => r.url.includes('evil.test'))).toBe(false)
  })

  it('confines a connection to its own drive, whatever handle a caller passes', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, { rootId: microsoftRoot({ driveId: 'b!acme-drive' }) })

    // A folder handle that names ANOTHER drive is refused, not silently
    // honoured and not silently ignored.
    await expect(
      h.drives.listItems(view.id, { folderId: 'drive:b!somebody-else/item:01ZZZ' }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
    // And so is one that tries to walk up out of the drive.
    await expect(h.drives.listItems(view.id, { folderId: '..' })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
  })

  it('addresses a SharePoint site library through an explicit handle', async () => {
    const h = harness({ server: { files: FILES } })
    const site = 'contoso.sharepoint.com,8b1e7d20-0000-0000-0000-000000000001,7f2c'
    const view = await connect(h, { rootId: microsoftRoot({ siteId: site }) })

    await h.drives.listItems(view.id).catch(() => undefined)
    const listing = h.graph.requests.filter((r) => r.url.includes('/children')).at(-1)!
    expect(listing.url).toContain(`/v1.0/sites/${encodeURI(site)}/drive/root/children`)
  })
})

describe('metadata', () => {
  it('returns null for an item Graph no longer has, rather than failing an import', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    expect(await h.drives.getItem(view.id, '01AAA')).not.toBeNull()
    expect(await h.drives.getItem(view.id, '01MISSING')).toBeNull()
  })
})

describe('download', () => {
  it('uses the pre-signed URL and never sends the Graph token to the content host', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items.find((i) => i.externalId === '01AAA')!

    const content = await h.drives.download(view.id, item)
    expect(await readAll(content.stream)).toBe('invoice bytes')

    const cdn = h.graph.requests.filter((r) => r.url.includes('acme-my.sharepoint.com'))
    expect(cdn).toHaveLength(1)
    // The URL carries its own short-lived token. Presenting a Graph bearer
    // token as well would hand a far wider credential to a host that needs
    // nothing.
    expect(cdn[0]!.headers['authorization']).toBeUndefined()
  })

  it('never lets the pre-signed URL reach an item, a cursor or the listing', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const items = (await h.drives.listItems(view.id)).items

    // A `@microsoft.graph.downloadUrl` is a bearer credential. `raw` is
    // persisted by sinks and serialised into logs, so the listing must not
    // even ask Graph for it.
    expect(JSON.stringify(items)).not.toContain('tempauth')
    expect(JSON.stringify(items)).not.toContain('PRESIGNED-SECRET')
    expect(items[0]?.raw).toEqual({ driveId: 'b!acme-drive' })
    const listing = h.graph.requests.filter((r) => r.url.includes('/children')).at(-1)!
    expect(listing.url).not.toContain('downloadUrl')
  })

  it('keeps the pre-signed URL out of the error when the content host refuses', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items.find((i) => i.externalId === '01AAA')!

    // Three refusals from the CONTENT host, because a 403 there is usually an
    // expired pre-signed URL and is therefore retryable — each attempt re-reads
    // the metadata and gets a fresh one.
    h.graph.failCdnCalls = 3

    const error = await h.drives.download(view.id, item).catch((caught: unknown) => caught)
    const serialised = JSON.stringify({
      message: (error as Error).message,
      details: (error as { details?: unknown }).details,
    })
    expect((error as { code?: string }).code).toBe('DRIVE_PROVIDER_ERROR')
    // Nothing from the content host's body is forwarded: its error pages quote
    // the request URL, and that URL is a credential.
    expect(serialised).not.toContain('PRESIGNED-SECRET')
    expect(serialised).not.toContain('tempauth')
    expect(serialised).toContain('downloadRejected')
  })

  it('refuses an export-only item instead of failing mysteriously later', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    const notebook = (await h.drives.listItems(view.id)).items.find((i) => i.externalId === '01CCC')!

    await expect(h.drives.download(view.id, notebook)).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' })
  })

  it('drops the Authorization header when /content redirects to the CDN', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items.find((i) => i.externalId === '01AAA')!

    // Force the fallback path: Graph answers the metadata call without a
    // pre-signed URL, so the adapter falls back to `/content`, which 302s to
    // the content host. The guarded fetch re-validates the hop — and must not
    // carry the bearer token across it.
    h.graph.queue(200, JSON.stringify({ id: '01AAA', name: 'invoice.pdf', size: 13, file: { mimeType: 'text/plain' } }))

    const content = await h.drives.download(view.id, item)
    expect(await readAll(content.stream)).toBe('invoice bytes')
    const cdn = h.graph.requests.filter((r) => r.url.includes('acme-my.sharepoint.com')).at(-1)!
    expect(cdn.headers['authorization']).toBeUndefined()
    // …while the hop to Graph itself was of course authenticated.
    const graphHop = h.graph.requests.filter((r) => r.url.includes('/content')).at(-1)!
    expect(graphHop.headers['authorization']).toMatch(/^Bearer /)
  })
})

describe('the download host is attacker-influenced data', () => {
  it('refuses a pre-signed URL on a look-alike host', async () => {
    // The exact attack the `.suffix` rule exists for: `evilsharepoint.com`
    // ends with `sharepoint.com`, and a naive `endsWith` check would wave it
    // through. A tenant who can place a file in a shared library influences
    // what Graph says about it, so this host is data, not configuration.
    const h = harness({ server: { files: FILES, downloadHost: 'evilsharepoint.com' } })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items.find((i) => i.externalId === '01AAA')!

    await expect(h.drives.download(view.id, item)).rejects.toMatchObject({ code: 'DRIVE_HOST_NOT_ALLOWED' })
  })

  it('refuses a pre-signed URL on the bare parent domain', async () => {
    const h = harness({ server: { files: FILES, downloadHost: 'sharepoint.com' } })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items.find((i) => i.externalId === '01AAA')!

    // `.sharepoint.com` allows subdomains ONLY. The bare parent is never a
    // content host, and allowing it would widen the guard for nothing.
    await expect(h.drives.download(view.id, item)).rejects.toMatchObject({ code: 'DRIVE_HOST_NOT_ALLOWED' })
  })

  it('names the host in the refusal and nothing else', async () => {
    const h = harness({ server: { files: FILES, downloadHost: 'evilsharepoint.com' } })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items.find((i) => i.externalId === '01AAA')!

    const error = await h.drives.download(view.id, item).catch((caught: unknown) => caught)
    const serialised = JSON.stringify({
      message: (error as Error).message,
      details: (error as { details?: unknown }).details,
    })
    // The URL is a bearer credential for the file, so the error carries the
    // host — which an operator needs — and no path, no query, no `tempauth`.
    expect(serialised).toContain('evilsharepoint.com')
    expect(serialised).not.toContain('tempauth')
    expect(serialised).not.toContain('PRESIGNED-SECRET')
    expect(serialised).not.toContain('download.aspx')
  })

  it('refuses a redirect off the allowlist on the /content fallback too', async () => {
    const h = harness({ server: { files: FILES, downloadHost: 'evilsharepoint.com' } })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items.find((i) => i.externalId === '01AAA')!
    // No pre-signed URL in the metadata, so the adapter falls back to
    // `/content` — whose 302 is re-validated from scratch, exactly like the
    // first hop.
    h.graph.queue(200, JSON.stringify({ id: '01AAA', name: 'invoice.pdf', size: 13, file: {} }))

    await expect(h.drives.download(view.id, item)).rejects.toMatchObject({ code: 'DRIVE_HOST_NOT_ALLOWED' })
  })
})

describe('items with no downloadable bytes', () => {
  it('marks a OneNote package and a shared shortcut as export-only', async () => {
    const h = harness({
      server: {
        pageSize: 10,
        files: [
          { id: '01AAA', name: 'invoice.pdf', content: 'invoice bytes' },
          { id: '01CCC', name: 'notes.one', content: '', isPackage: true },
          { id: '01DDD', name: 'shared.docx', content: 'elsewhere', isShortcut: true },
        ],
      },
    })
    const view = await connect(h)
    const items = (await h.drives.listItems(view.id)).items

    expect(items.find((i) => i.externalId === '01CCC')?.exportOnly).toBe(true)
    // A "Shared with me" shortcut's bytes live in another drive, and a
    // connection is confined to one. Saying so is what keeps `importItem` from
    // turning each one into a job that fails and re-enqueues for ever.
    expect(items.find((i) => i.externalId === '01DDD')?.exportOnly).toBe(true)
    expect(items.find((i) => i.externalId === '01AAA')?.exportOnly).toBeUndefined()
  })

  it('is skipped by the import pipeline as `no-content`, not retried', async () => {
    const h = harness({
      server: { pageSize: 10, files: [{ id: '01CCC', name: 'notes.one', content: '', isPackage: true }] },
    })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items[0]!
    const before = h.graph.requests.length

    const outcome = await importItem(h.drives, view.id, item, async () => ({ targetId: 'never' }))

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'no-content' })
    // Nothing was downloaded, and nothing will be on the next sync either.
    expect(h.graph.requests.length).toBe(before)
  })
})

describe('upload', () => {
  it('writes a small file and streams the body', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)

    const created = await h.drives.upload(view.id, {
      name: 'receipt.txt',
      contentType: 'text/plain',
      content: Readable.from([Buffer.from('receipt bytes')]),
    })

    expect(created.name).toBe('receipt.txt')
    const upload = h.graph.requests.filter((r) => r.method === 'PUT').at(-1)!
    expect(upload.url).toContain('/v1.0/me/drive/root:/receipt.txt:/content')
    expect(upload.body).toBe('receipt bytes')
  })

  it('refuses anything over Graph’s 4 MB simple-upload ceiling up front', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const before = h.graph.requests.length

    await expect(
      h.drives.upload(view.id, {
        name: 'big.bin',
        contentType: 'application/octet-stream',
        content: Readable.from([Buffer.alloc(16)]),
        size: 5 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_CONTENT_TOO_LARGE' })
    // Refused BEFORE the bytes were sent: `createUploadSession` is a documented
    // limitation, not a silent one.
    expect(h.graph.requests.length).toBe(before)
  })

  it('strips path separators out of a filename rather than escaping them', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)

    await h.drives.upload(view.id, {
      name: '../../etc/passwd',
      contentType: 'text/plain',
      content: Readable.from([Buffer.from('x')]),
    })
    const upload = h.graph.requests.filter((r) => r.method === 'PUT').at(-1)!
    // The name is one path segment, whatever was in it: separators are removed
    // rather than escaped, so `..` can only ever be part of a filename and
    // never a step up the tree.
    const name = decodeURIComponent(/root:\/([^/]+):\/content/.exec(upload.url)![1]!)
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    // `..` survives only as ordinary characters inside one segment, which is
    // what "removed rather than escaped" means: there is no separator left for
    // it to be a step in a path.
    expect(name).toBe('__.._etc_passwd')
  })
})

describe('what never goes on the wire', () => {
  it('sends the access token only to Microsoft-owned API hosts', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const item = (await h.drives.listItems(view.id)).items[0]!
    await readAll((await h.drives.download(view.id, item)).stream)

    for (const request of h.graph.requests) {
      if (request.headers['authorization'] === undefined) continue
      expect(new URL(request.url).hostname).toMatch(/^(graph\.microsoft\.com)$/)
    }
    // And the client secret only ever reached the token endpoint.
    for (const request of h.graph.requests) {
      if (!request.body.includes('client_secret')) continue
      expect(request.url).toContain('login.microsoftonline.com')
    }
    expect(wireText(h)).not.toContain('"authorization":"Bearer access-1","url":"https://acme-my')
  })
})
