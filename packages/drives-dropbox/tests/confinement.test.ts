import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { connect, harness } from './helpers.js'

/**
 * FA-073 — a connection with a `rootId` is confined to that folder. Dropbox
 * addresses items by path or by `id:`, and either can name something outside
 * the root, so every caller-supplied handle is resolved to its `path_lower`
 * and checked against the root's before it is used.
 */
const FILES = [
  { id: 'id:fin', path: '/Finance', content: '', isFolder: true },
  { id: 'id:a', path: '/Finance/invoice.pdf', content: 'invoice bytes' },
  { id: 'id:sub', path: '/Finance/2026', content: '', isFolder: true },
  { id: 'id:hr', path: '/HR', content: '', isFolder: true },
  { id: 'id:s', path: '/HR/salaries.xlsx', content: 'secret bytes' },
  { id: 'id:twin', path: '/Finance-old/x.pdf', content: 'look-alike prefix' },
]

describe('root confinement (FA-073)', () => {
  it('refuses a folder outside the root, by path or by id, and a traversal', async () => {
    const h = harness({ server: { files: FILES, pageSize: 50 } })
    const view = await connect(h, { rootId: '/Finance' })

    await expect(h.drives.listItems(view.id, { folderId: '/Finance/2026' })).resolves.toBeDefined()
    await expect(h.drives.listItems(view.id, { folderId: 'id:sub' })).resolves.toBeDefined()
    for (const folderId of ['/HR', 'id:hr', '/Finance/../HR', '/Finance-old']) {
      await expect(h.drives.listItems(view.id, { folderId })).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
    }
    const listed = h.dropbox.requests.filter((r) => r.url.endsWith('/list_folder')).map((r) => r.body)
    expect(listed.some((body) => body.toLowerCase().includes('/hr'))).toBe(false)
  })

  it('reports an item outside the root as absent', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, { rootId: '/Finance' })
    expect((await h.drives.getItem(view.id, 'id:a'))?.name).toBe('invoice.pdf')
    expect(await h.drives.getItem(view.id, 'id:s')).toBeNull()
    expect(await h.drives.getItem(view.id, '/HR/salaries.xlsx')).toBeNull()
  })

  it('refuses to hand over the bytes of an item outside the root', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, { rootId: '/Finance' })
    const ok = await h.drives.download(view.id, { externalId: 'id:a', name: 'invoice.pdf', kind: 'file' })
    ok.stream.destroy()
    await expect(
      h.drives.download(view.id, { externalId: 'id:s', name: 'salaries.xlsx', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
  })

  it('refuses to upload into a folder outside the root', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, { rootId: '/Finance' })
    await expect(
      h.drives.upload(view.id, {
        name: 'x.txt',
        contentType: 'text/plain',
        content: Readable.from([Buffer.from('x')]),
        folderId: 'id:hr',
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
    expect(h.dropbox.requests.some((r) => r.url.endsWith('/files/upload'))).toBe(false)
  })

  it('confines to a root given as an id, too', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, { rootId: 'id:fin' })
    expect((await h.drives.getItem(view.id, 'id:a'))?.name).toBe('invoice.pdf')
    expect(await h.drives.getItem(view.id, 'id:s')).toBeNull()
  })
})
