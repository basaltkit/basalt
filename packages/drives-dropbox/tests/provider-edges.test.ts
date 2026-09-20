import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { syncConnection } from '@basaltkit/drives'
import { dropboxDrive } from '../src/index.js'
import { connect, harness, readAll } from './helpers.js'

/**
 * The failure paths of the adapter proper.
 *
 * These are the ones an import pipeline actually meets in production — a file
 * deleted between the sync that discovered it and the job that downloads it, a
 * scope the tenant never granted, a token endpoint behind a captive portal —
 * and they are exactly the paths that stay untested when a fake only ever
 * answers 200.
 */

const FILES = [{ id: 'id:a', path: '/Finance/invoice.pdf', content: 'invoice bytes' }]
const notFound = JSON.stringify({ error_summary: 'path/not_found/...', error: { '.tag': 'path' } })
const denied = JSON.stringify({ error_summary: 'access_denied/insufficient_scope' })

describe('configuration', () => {
  it('refuses to construct without an app key', () => {
    // Failing at construction rather than at the first request: a missing key
    // is a deployment mistake, and finding it at boot is the difference
    // between a failed start and a tenant's sync quietly never working.
    expect(() => dropboxDrive({ clientId: '' })).toThrow(TypeError)
  })
})

describe('the token endpoint misbehaving', () => {
  it('reports a refused authorization code without leaking the vendor’s prose', async () => {
    const h = harness({ server: { files: FILES } })
    const start = h.drives.startAuthorization({
      provider: 'dropbox',
      redirectUri: 'https://app.test/drives/dropbox/callback',
    })
    await expect(
      h.drives.completeAuthorization({
        provider: 'dropbox',
        code: 'stolen-or-expired',
        redirectUri: 'https://app.test/drives/dropbox/callback',
        state: start.state,
        binding: start.binding,
        label: 'Drive Finance',
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })

  it('treats a non-JSON token response as a failure, not as a grant', async () => {
    const h = harness({ server: { files: FILES } })
    // A captive portal, a proxy error page, a truncated body. Anything that is
    // not a token response must not be parsed optimistically into one.
    h.dropbox.queue(200, '<html>proxy error</html>')
    const start = h.drives.startAuthorization({
      provider: 'dropbox',
      redirectUri: 'https://app.test/drives/dropbox/callback',
    })
    await expect(
      h.drives.completeAuthorization({
        provider: 'dropbox',
        code: 'good-code',
        redirectUri: 'https://app.test/drives/dropbox/callback',
        state: start.state,
        binding: start.binding,
        label: 'Drive Finance',
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })
})

describe('metadata failures', () => {
  it('rethrows a refusal rather than reporting the item as missing', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    h.dropbox.queue(403, denied)
    // Only `path/not_found` becomes `null`. A 403 means the item may well
    // exist — answering `null` would make an import silently skip a file the
    // tenant can see.
    await expect(h.drives.getItem(view.id, 'id:a')).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
  })
})

describe('download failures', () => {
  it('maps a file deleted between sync and download to a terminal not-found', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    // The race every import pipeline has: the sync enqueued it, someone
    // deleted it, the job runs. Terminal, so the job stops instead of
    // retrying a file that will never come back.
    await expect(
      h.drives.download(view.id, { externalId: 'id:gone', name: 'gone.pdf', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'DRIVE_ITEM_NOT_FOUND' })
  })

  it('maps a refused download to access denied', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    h.dropbox.queue(403, denied)
    await expect(
      h.drives.download(view.id, { externalId: 'id:a', name: 'invoice.pdf', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
  })

  it('falls back to the item’s own size when Dropbox-API-Result is absent or junk', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    const item = { externalId: 'id:a', name: 'invoice.pdf', kind: 'file' as const, size: 99 }

    h.dropbox.queue(200, 'invoice bytes')
    const noHeader = await h.drives.download(view.id, item)
    expect(noHeader.size).toBe(99)
    expect(await readAll(noHeader.stream)).toBe('invoice bytes')

    h.dropbox.queue(200, 'invoice bytes', { 'dropbox-api-result': 'not json' })
    const junkHeader = await h.drives.download(view.id, item)
    // A header we cannot parse is ignored, never allowed to throw on a path
    // whose whole job is to hand back a stream.
    expect(junkHeader.size).toBe(99)
    junkHeader.stream.destroy()
  })
})

describe('upload failures', () => {
  it('maps a missing write scope to access denied', async () => {
    const h = harness({ server: { files: [] } })
    const view = await connect(h)
    h.dropbox.queue(403, denied)
    // The common misconfiguration: the app asked for read scopes only.
    // Re-consenting WOULD fix this one, but it is still not a dead grant.
    await expect(
      h.drives.upload(view.id, {
        name: 'report.pdf',
        contentType: 'application/pdf',
        content: Readable.from([Buffer.from('report')]),
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
  })
})

describe('a malformed change feed', () => {
  it('fails loudly when list_folder hands back no cursor', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)
    h.dropbox.queue(200, JSON.stringify({ entries: [], has_more: false }))
    // Without a cursor there is nothing to resume from. Carrying on would
    // restart the feed from the top on every run, for ever, in silence.
    await expect(
      syncConnection(h.drives, view.id, { enqueue: async () => {} }),
    ).rejects.toThrow(/no cursor/)
  })
})
