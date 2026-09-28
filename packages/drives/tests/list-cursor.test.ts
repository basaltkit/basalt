import { describe, expect, it } from 'vitest'
import { Drives } from '../src/drives.js'
import { connect, harness, TEST_KEYS } from './helpers.js'

const FILES = Array.from({ length: 5 }, (_, i) => ({ externalId: `f${i}`, name: `file-${i}.txt` }))

/**
 * FA-072 / FA-073 — a list cursor is something a caller hands back, and an
 * adapter's own cursor is not something a caller may author. Graph's cursor
 * is a whole URL fetched with the connection's bearer token; Google's walk
 * cursor names the folders to descend into. `listItems` therefore wraps the
 * adapter's cursor in a MAC bound to the tenant and the connection,
 * and hands the adapter nothing that does not verify.
 */
describe('list cursors are bound to what issued them', () => {
  it('round-trips a cursor it issued, and never exposes the adapter’s own', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })

    const first = await h.drives.listItems(view.id, { tenantId: 'acme', limit: 2 })
    expect(first.cursor).toMatch(/^bkl1\./)
    const second = await h.drives.listItems(view.id, { tenantId: 'acme', limit: 2, cursor: first.cursor })
    expect(second.items.map((i) => i.externalId)).toEqual(['f2', 'f3'])
  })

  it('refuses a cursor the caller wrote, before the adapter sees it', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })
    const before = h.fake.calls['list'] ?? 0

    // The raw adapter cursor — what an attacker would forge — is refused.
    await expect(h.drives.listItems(view.id, { tenantId: 'acme', cursor: '4' })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
    // So is a well-formed envelope whose inner cursor was swapped.
    const issued = (await h.drives.listItems(view.id, { tenantId: 'acme', limit: 2 })).cursor!
    const [version, , mac] = issued.split('.')
    const swapped = `${version}.${Buffer.from('4').toString('base64url')}.${mac}`
    await expect(h.drives.listItems(view.id, { tenantId: 'acme', cursor: swapped })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
    // One legitimate listing call, and none for the two refusals.
    expect(h.fake.calls['list']).toBe(before + 1)
  })

  it('refuses a cursor issued for another connection or tenant', async () => {
    const h = harness({ provider: { files: FILES } })
    const finance = await connect(h, { tenantId: 'acme', label: 'Finance' })
    const hr = await connect(h, { tenantId: 'acme', label: 'HR' })
    const globex = await connect(h, { tenantId: 'globex' })

    const issued = (await h.drives.listItems(finance.id, { tenantId: 'acme', limit: 2 })).cursor!
    await expect(h.drives.listItems(hr.id, { tenantId: 'acme', cursor: issued })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
    await expect(h.drives.listItems(globex.id, { tenantId: 'globex', cursor: issued })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
  })

  it('refuses a cursor signed under a different app secret', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })
    const issued = (await h.drives.listItems(view.id, { tenantId: 'acme', limit: 2 })).cursor!

    const rotated = new Drives({
      providers: [h.fake],
      keys: TEST_KEYS,
      secret: 'a-different-app-secret',
      store: h.store,
      now: h.now,
    })
    await expect(rotated.listItems(view.id, { tenantId: 'acme', cursor: issued })).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
  })
})
