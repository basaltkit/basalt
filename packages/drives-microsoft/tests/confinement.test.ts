import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { microsoftRoot } from '../src/index.js'
import { connect, harness } from './helpers.js'

/**
 * FA-073 — a connection rooted at a folder (`item:{id}`) is confined to that
 * folder's subtree, not just to its drive. A `folderId`, an item to read or
 * download and an upload target are each checked by walking
 * `parentReference.id` up to the root.
 */
const FILES = [
  { id: '01ROOT', name: 'Finance', content: '', isFolder: true },
  { id: '01SUB', name: '2026', content: '', isFolder: true, parentId: '01ROOT' },
  { id: '01DEEP', name: 'invoice.pdf', content: 'invoice bytes', parentId: '01SUB' },
  { id: '01HR', name: 'HR', content: '', isFolder: true },
  { id: '01SECRET', name: 'salaries.xlsx', content: 'secret bytes', parentId: '01HR' },
]

const rooted = { rootId: microsoftRoot({ driveId: 'b!acme-drive', itemId: '01ROOT' }) }

describe('folder confinement (FA-073)', () => {
  it('lists a folder inside the root and refuses one outside it', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h, rooted)

    const inside = await h.drives.listItems(view.id, { folderId: '01SUB' })
    expect(inside.items.map((i) => i.externalId)).toEqual(['01DEEP'])

    await expect(h.drives.listItems(view.id, { folderId: '01HR' })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
    expect(h.graph.requests.some((r) => r.url.includes('/items/01HR/children'))).toBe(false)
  })

  it('reads metadata inside the root and reports an item outside it as absent', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, rooted)
    expect((await h.drives.getItem(view.id, '01DEEP'))?.name).toBe('invoice.pdf')
    expect(await h.drives.getItem(view.id, '01SECRET')).toBeNull()
  })

  it('refuses to download an item outside the root before asking for its bytes', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, rooted)
    const ok = await h.drives.download(view.id, { externalId: '01DEEP', name: 'invoice.pdf', kind: 'file' })
    ok.stream.destroy()

    await expect(
      h.drives.download(view.id, { externalId: '01SECRET', name: 'salaries.xlsx', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
    expect(h.graph.requests.some((r) => r.url.includes('downloadUrl') && r.url.includes('01SECRET'))).toBe(false)
    expect(h.graph.requests.some((r) => r.url.includes('UniqueId=01SECRET'))).toBe(false)
  })

  it('refuses to upload into a folder outside the root', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, rooted)
    await expect(
      h.drives.upload(view.id, {
        name: 'x.txt',
        contentType: 'text/plain',
        content: Readable.from([Buffer.from('x')]),
        folderId: '01HR',
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS_DENIED' })
  })

  it('costs nothing for a connection confined only to its drive', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h, { rootId: microsoftRoot({ driveId: 'b!acme-drive' }) })
    const before = h.graph.requests.length
    expect((await h.drives.getItem(view.id, '01SECRET'))?.name).toBe('salaries.xlsx')
    expect(h.graph.requests.length - before).toBe(1)
  })
})
