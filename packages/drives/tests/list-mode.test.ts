import { describe, expect, it } from 'vitest'
import { DriveAccessDeniedError } from '../src/errors.js'
import { connect, harness } from './helpers.js'

const files = [
  { externalId: 'a', name: 'a' },
  { externalId: 'b', name: 'b' },
  { externalId: 'c', name: 'c' },
]

describe('listItems — per-call listing mode', () => {
  it('passes recursive through to the adapter only when the caller sets it', async () => {
    const h = harness({ provider: { files } })
    const view = await connect(h, { tenantId: 'acme' })
    await h.drives.listItems(view.id, { tenantId: 'acme' })
    expect(h.fake.lastListOptions).not.toHaveProperty('recursive')
    await h.drives.listItems(view.id, { tenantId: 'acme', recursive: false })
    expect(h.fake.lastListOptions?.recursive).toBe(false)
    await h.drives.listItems(view.id, { tenantId: 'acme', recursive: true })
    expect(h.fake.lastListOptions?.recursive).toBe(true)
  })

  it('a default-mode cursor keeps the v1 envelope', async () => {
    const h = harness({ provider: { files, pageSize: 1 } })
    const view = await connect(h, { tenantId: 'acme' })
    const page = await h.drives.listItems(view.id, { tenantId: 'acme' })
    expect(page.cursor).toMatch(/^bkl1\./)
  })

  it('a continuation that omits recursive keeps the mode the cursor was minted with', async () => {
    const h = harness({ provider: { files, pageSize: 1 } })
    const view = await connect(h, { tenantId: 'acme' })
    const first = await h.drives.listItems(view.id, { tenantId: 'acme', recursive: false })
    expect(first.cursor).toMatch(/^bkl2\./)
    await h.drives.listItems(view.id, { tenantId: 'acme', cursor: first.cursor! })
    expect(h.fake.lastListOptions?.recursive).toBe(false)
  })

  it('refuses a cursor minted for one mode when continued under another', async () => {
    const h = harness({ provider: { files, pageSize: 1 } })
    const view = await connect(h, { tenantId: 'acme' })
    const browse = await h.drives.listItems(view.id, { tenantId: 'acme', recursive: false })
    await expect(
      h.drives.listItems(view.id, { tenantId: 'acme', cursor: browse.cursor!, recursive: true }),
    ).rejects.toThrow(DriveAccessDeniedError)

    const deflt = await h.drives.listItems(view.id, { tenantId: 'acme' })
    await expect(
      h.drives.listItems(view.id, { tenantId: 'acme', cursor: deflt.cursor!, recursive: false }),
    ).rejects.toThrow(DriveAccessDeniedError)
  })

  it('refuses a cursor whose mode was rewritten', async () => {
    const h = harness({ provider: { files, pageSize: 1 } })
    const view = await connect(h, { tenantId: 'acme' })
    const browse = await h.drives.listItems(view.id, { tenantId: 'acme', recursive: false })
    const forged = browse.cursor!.replace(/^bkl2\.([^.]*)\.c\./, 'bkl2.$1.r.')
    expect(forged).not.toBe(browse.cursor)
    await expect(h.drives.listItems(view.id, { tenantId: 'acme', cursor: forged })).rejects.toThrow(
      DriveAccessDeniedError,
    )
  })
})
