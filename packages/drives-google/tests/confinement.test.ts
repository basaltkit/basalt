import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { FOLDER_MIME } from './google-server.js'
import { connect, harness } from './helpers.js'

/**
 * FA-073 — a connection with a `rootId` is "confined to" that folder
 * (`DriveSession.rootId`). Every id a caller can hand the adapter — a
 * `folderId`, an item to read or download, a folder to upload into — is
 * therefore checked against the root's subtree by walking `parents`, and
 * anything outside it is refused the way a missing item is.
 */
const TREE = [
  { id: 'root-folder', name: 'Finance', mimeType: FOLDER_MIME, parents: [] },
  { id: 'sub-folder', name: '2026', mimeType: FOLDER_MIME, parents: ['root-folder'] },
  { id: 'top', name: 'summary.pdf', content: 'summary bytes', parents: ['root-folder'] },
  { id: 'deep', name: 'invoice.pdf', content: 'invoice bytes', parents: ['sub-folder'] },
  { id: 'other-folder', name: 'HR', mimeType: FOLDER_MIME, parents: [] },
  { id: 'elsewhere', name: 'private.pdf', content: 'other folder bytes', parents: ['other-folder'] },
]

describe('rootId confinement (FA-073)', () => {
  it('lists a folder inside the root, and refuses one outside it', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 }, provider: { listMode: 'children' } })
    const view = await connect(h, { rootId: 'root-folder' })

    const inside = await h.drives.listItems(view.id, { folderId: 'sub-folder' })
    expect(inside.items.map((i) => i.externalId)).toEqual(['deep'])

    await expect(h.drives.listItems(view.id, { folderId: 'other-folder' })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
    expect(h.google.requests.some((r) => decodeURIComponent(r.url).includes("'other-folder' in parents"))).toBe(false)
  })

  it('refuses an out-of-root folder for a recursive walk too', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h, { rootId: 'root-folder' })
    await expect(h.drives.listItems(view.id, { folderId: 'other-folder' })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
  })

  it('reads metadata inside the root and reports an item outside it as absent', async () => {
    const h = harness({ server: { files: TREE } })
    const view = await connect(h, { rootId: 'root-folder' })
    expect((await h.drives.getItem(view.id, 'deep'))?.name).toBe('invoice.pdf')
    expect(await h.drives.getItem(view.id, 'elsewhere')).toBeNull()
  })

  it('downloads inside the root and refuses outside it before any bytes move', async () => {
    const h = harness({ server: { files: TREE } })
    const view = await connect(h, { rootId: 'root-folder' })
    const ok = await h.drives.download(view.id, { externalId: 'deep', name: 'invoice.pdf', kind: 'file' })
    ok.stream.destroy()

    await expect(
      h.drives.download(view.id, { externalId: 'elsewhere', name: 'private.pdf', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
    expect(h.google.requests.some((r) => r.url.includes('/files/elsewhere?alt=media'))).toBe(false)
  })

  it('refuses to upload into a folder outside the root', async () => {
    const h = harness({ server: { files: TREE } })
    const view = await connect(h, { rootId: 'root-folder', })
    await expect(
      h.drives.upload(view.id, {
        name: 'x.txt',
        contentType: 'text/plain',
        content: Readable.from([Buffer.from('x')]),
        folderId: 'other-folder',
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
  })

  it('leaves an unconfined connection alone, with no extra reads', async () => {
    const h = harness({ server: { files: TREE } })
    const view = await connect(h)
    const before = h.google.requests.length
    expect((await h.drives.getItem(view.id, 'elsewhere'))?.name).toBe('private.pdf')
    expect(h.google.requests.length - before).toBe(1)
  })
  it('resolves the `root` alias before walking, rather than refusing everything', async () => {
    const files = [
      { id: 'my-drive', name: 'My Drive', mimeType: FOLDER_MIME, parents: [] },
      { id: 'mine', name: 'mine.pdf', content: 'mine', parents: ['my-drive'] },
      { id: 'shared-drive-file', name: 'theirs.pdf', content: 'theirs', parents: ['shared-drive'] },
    ]
    const h = harness({ server: { files, myDriveId: 'my-drive' } })
    const view = await connect(h, { rootId: 'root' })
    expect((await h.drives.getItem(view.id, 'mine'))?.name).toBe('mine.pdf')
    expect(await h.drives.getItem(view.id, 'shared-drive-file')).toBeNull()
  })
})
