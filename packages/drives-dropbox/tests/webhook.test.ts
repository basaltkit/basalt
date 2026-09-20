import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { handleNotification, type DriveNotificationInput, type DriveProvider } from '@basaltkit/drives'
import { dropboxDrive } from '../src/index.js'
import { APP_SECRET, connect, harness } from './helpers.js'

const ACCOUNT = 'dbid:AAH-ACME'

function notification(accounts: readonly string[], options: { secret?: string; body?: string } = {}): DriveNotificationInput {
  const body = Buffer.from(options.body ?? JSON.stringify({ list_folder: { accounts }, delta: { users: [1] } }))
  return {
    method: 'POST',
    headers: {
      'x-dropbox-signature': createHmac('sha256', options.secret ?? APP_SECRET).update(body).digest('hex'),
      'content-type': 'application/json',
    },
    query: {},
    body,
  }
}

describe('the challenge handshake', () => {
  it('echoes the challenge without consulting any connection', () => {
    const provider = dropboxDrive({ clientId: 'k', clientSecret: APP_SECRET })
    // Dropbox sends this when the URI is SAVED in the App Console — before any
    // tenant has connected anything. A route that looked a connection up here
    // could never answer it.
    const result = provider.verifyNotification({
      method: 'GET',
      headers: {},
      query: { challenge: 'abc123' },
      body: Buffer.alloc(0),
    })
    expect(result).toEqual({ challenge: 'abc123', changed: false })
  })

  it('refuses an oversized challenge rather than reflecting it', () => {
    const provider = dropboxDrive({ clientId: 'k', clientSecret: APP_SECRET })
    // The challenge is reflected verbatim; the length bound is what keeps this
    // endpoint from being an echo service.
    expect(() =>
      provider.verifyNotification({
        method: 'GET',
        headers: {},
        query: { challenge: 'x'.repeat(300) },
        body: Buffer.alloc(0),
      }),
    ).toThrow(/too long/)
  })

  it('refuses a GET with no challenge', () => {
    const provider = dropboxDrive({ clientId: 'k', clientSecret: APP_SECRET })
    expect(() =>
      provider.verifyNotification({ method: 'GET', headers: {}, query: {}, body: Buffer.alloc(0) }),
    ).toThrow(/challenge/)
  })
})

describe('signature verification', () => {
  const provider = dropboxDrive({ clientId: 'k', clientSecret: APP_SECRET })

  it('accepts a signature over the raw bytes', () => {
    const result = provider.verifyNotification(notification([ACCOUNT]))
    expect(result.accountIds).toEqual([ACCOUNT])
    expect(result.changed).toBe(true)
    // Dropbox has no per-subscription secret at all.
    expect(result.secret).toBeUndefined()
  })

  it('rejects a body signed with another secret', () => {
    expect(() => provider.verifyNotification(notification([ACCOUNT], { secret: 'not-our-secret' }))).toThrow(
      /signature/,
    )
  })

  it('rejects a signature over a re-serialised body', () => {
    const real = notification([ACCOUNT])
    // Same JSON, different bytes: this is why DriveNotificationInput.body is a
    // Buffer and why the route refuses to reconstruct one.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(real.body.toString()), null, 2))
    expect(() =>
      provider.verifyNotification({ ...real, body: reserialised }),
    ).toThrow(/signature/)
  })

  it('rejects a missing signature instead of treating it as unsigned', () => {
    const real = notification([ACCOUNT])
    expect(() => provider.verifyNotification({ ...real, headers: {} })).toThrow(/signature/)
  })

  it('fails closed when no signing secret is configured', () => {
    const unsigned = dropboxDrive({ clientId: 'k' })
    // An adapter with no key cannot tell a real notification from a forged one.
    expect(() => unsigned.verifyNotification(notification([ACCOUNT]))).toThrow(/signing secret/)
  })

  it('rejects a body that is not JSON, after the signature passes', () => {
    expect(() => provider.verifyNotification(notification([], { body: 'not json' }))).toThrow(/not JSON/)
  })
})

describe('correlation to connections', () => {
  it('resolves a notification to every connection on that account', async () => {
    const h = harness()
    // The same Dropbox account connected twice by one tenant — "Drive Finance"
    // and "Drive HR" — is exactly the case the RFC set out to support, and one
    // notification concerns both.
    const finance = await connect(h, { tenantId: 'acme', label: 'Drive Finance' })
    const hr = await connect(h, { tenantId: 'acme', label: 'Drive HR' })
    const connections = await h.store.list('acme')

    const outcome = await handleNotification(h.drives, notification([ACCOUNT]), {
      provider: 'dropbox',
      connections,
    })

    expect(outcome.shouldSync).toBe(true)
    expect(outcome.connections.map((c) => c.id).sort()).toEqual([finance.id, hr.id].sort())
  })

  it('reaches a connection through an app-wide resolver, by the account the signature vouched for', async () => {
    const h = harness()
    const acme = await connect(h, { tenantId: 'acme' })
    await connect(h, { tenantId: 'globex' })
    let asked: readonly string[] | undefined

    const outcome = await handleNotification(h.drives, notification([ACCOUNT]), {
      provider: 'dropbox',
      connections: async (query) => {
        asked = query.accountIds
        // An app's own query. The framework never scans across tenants itself.
        return (await h.store.list('acme')).filter((c) => c.account?.id === ACCOUNT)
      },
    })

    expect(asked).toEqual([ACCOUNT])
    expect(outcome.connections.map((c) => c.id)).toEqual([acme.id])
  })

  it('answers an unknown account exactly as it answers a known one', async () => {
    const h = harness()
    await connect(h, { tenantId: 'acme' })
    const connections = await h.store.list('acme')

    const known = await handleNotification(h.drives, notification([ACCOUNT]), { provider: 'dropbox', connections })
    const unknown = await handleNotification(h.drives, notification(['dbid:SOMEONE-ELSE']), {
      provider: 'dropbox',
      connections,
    })

    // Neither throws, so a route answers 200 for both. Knowing which accounts a
    // deployment holds is exactly what this endpoint must not tell anyone.
    expect(unknown.connections).toEqual([])
    expect(unknown.reason).toBe('unmatched')
    expect(known.shouldSync).toBe(true)
  })

  it('cannot be made to sync a connection in another tenant', async () => {
    const h = harness()
    await connect(h, { tenantId: 'globex' })
    const outcome = await handleNotification(h.drives, notification([ACCOUNT]), {
      provider: 'dropbox',
      tenantId: 'acme',
      connections: await h.store.list('globex'),
    })
    expect(outcome.connections).toEqual([])
  })

  it('never matches a connection whose account was never recorded', async () => {
    const h = harness()
    await connect(h, { tenantId: 'acme' })
    const connections = (await h.store.list('acme')).map((c) => ({ ...c, account: undefined }))
    // Fail closed: a missing account id must not behave like a wildcard.
    const outcome = await handleNotification(h.drives, notification([ACCOUNT]), {
      provider: 'dropbox',
      connections,
    })
    expect(outcome.connections).toEqual([])
  })

  it('collapses a replayed delivery', async () => {
    const h = harness()
    await connect(h, { tenantId: 'acme' })
    const connections = await h.store.list('acme')
    const { MemoryReplayGuard } = await import('@basaltkit/drives')
    const replayGuard = new MemoryReplayGuard(h.now)
    const delivery = notification([ACCOUNT])

    const first = await handleNotification(h.drives, delivery, { provider: 'dropbox', connections, replayGuard })
    const second = await handleNotification(h.drives, delivery, { provider: 'dropbox', connections, replayGuard })

    expect(first.shouldSync).toBe(true)
    expect(second.shouldSync).toBe(false)
    expect(second.reason).toBe('replay')
  })

  it('does not subscribe: Dropbox has no per-connection watch to register', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    const { watchConnection } = await import('@basaltkit/drives')
    // Absent rather than throwing from inside: the engine probes for the
    // method, so the honest answer is DRIVE_UNSUPPORTED.
    expect((h.provider as DriveProvider).watch).toBeUndefined()
    await expect(
      watchConnection(h.drives, view.id, { tenantId: 'acme', notificationUrl: 'https://app.test/hook' }),
    ).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' })
  })

  it('never turns a notification into a provider call by itself', async () => {
    const h = harness()
    await connect(h, { tenantId: 'acme' })
    const before = h.dropbox.requests.length
    await handleNotification(h.drives, notification([ACCOUNT]), {
      provider: 'dropbox',
      connections: await h.store.list('acme'),
    })
    // Verification is pure: hammering the endpoint cannot be amplified into
    // Dropbox traffic.
    expect(h.dropbox.requests.length).toBe(before)
  })
})
