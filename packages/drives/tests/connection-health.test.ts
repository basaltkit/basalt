import { describe, expect, it } from 'vitest'
import { DriveConnectionNotFoundError } from '../src/errors.js'
import { syncConnection } from '../src/sync.js'
import { connect, harness } from './helpers.js'

const PAST_EXPIRY = 2 * 60 * 60_000

describe('connection health', () => {
  it('check() stamps lastSucceededAt on success', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    expect(await h.drives.check(view.id, { tenantId: 'acme' })).toEqual({ ok: true })
    const stored = (await h.store.find('acme', view.id))!
    expect(stored.lastSucceededAt).toBe(h.now())
    expect(stored.lastFailedAt).toBeUndefined()
    expect(h.fake.calls['list']).toBe(1)
  })

  it('check() returns the error code and stamps lastFailedAt instead of throwing', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    h.fake.rateLimitNextCalls = 10
    const result = await h.drives.check(view.id, { tenantId: 'acme' })
    expect(result).toEqual({ ok: false, code: 'DRIVE_RATE_LIMITED' })
    const stored = (await h.store.find('acme', view.id))!
    expect(stored.lastFailedAt).toBe(h.now())
    expect(stored.lastErrorCode).toBe('DRIVE_RATE_LIMITED')
  })

  it('check() still throws for a caller mistake', async () => {
    const h = harness()
    await expect(h.drives.check('missing', { tenantId: 'acme' })).rejects.toThrow(DriveConnectionNotFoundError)
  })

  it('a dead grant stamps lastFailedAt + DRIVE_CREDENTIALS_INVALID in the same write that marks it invalid', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    h.advance(PAST_EXPIRY)
    h.fake.grantRevoked = true
    await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow()
    const stored = (await h.store.find('acme', view.id))!
    expect(stored.status).toBe('invalid')
    expect(stored.lastErrorCode).toBe('DRIVE_CREDENTIALS_INVALID')
    expect(stored.lastFailedAt).toBe(h.now())
  })

  it('an ordinary successful call writes nothing', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    const before = (await h.store.find('acme', view.id))!.revision
    await h.drives.listItems(view.id, { tenantId: 'acme' })
    const after = (await h.store.find('acme', view.id))!
    expect(after.revision).toBe(before)
    expect(after.lastSucceededAt).toBeUndefined()
  })

  it('a completed sync stamps lastSucceededAt; a failed one stamps the code', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt', content: 'x' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })
    expect((await h.store.find('acme', view.id))!.lastSucceededAt).toBe(h.now())

    h.advance(1000)
    h.fake.rateLimitNextCalls = 10
    await expect(syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })).rejects.toThrow()
    const stored = (await h.store.find('acme', view.id))!
    expect(stored.lastFailedAt).toBe(h.now())
    expect(stored.lastErrorCode).toBe('DRIVE_RATE_LIMITED')
  })

  it('the view carries the health fields and never the secret', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    await h.drives.check(view.id, { tenantId: 'acme' })
    const fresh = await h.drives.get(view.id, 'acme')
    expect(fresh.lastSucceededAt).toBe(h.now())
    expect(JSON.stringify(fresh)).not.toContain('bkd1.')
    expect(fresh).not.toHaveProperty('secret')
  })
})
