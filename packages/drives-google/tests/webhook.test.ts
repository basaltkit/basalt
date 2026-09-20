import { describe, expect, it } from 'vitest'
import { MemoryReplayGuard, handleNotification, watchConnection } from '@basaltkit/drives'
import { googleDrive } from '../src/index.js'
import { CLIENT_ID, connect, harness } from './helpers.js'

const provider = googleDrive({ clientId: CLIENT_ID })

describe('subscribing', () => {
  it('registers a channel with the engine’s secret and surfaces the expiry', async () => {
    const h = harness()
    const view = await connect(h)

    const watch = await watchConnection(h.drives, view.id, { notificationUrl: 'https://app.test/drives/google/notify' })

    const request = h.google.requests.find((r) => r.url.includes('/changes/watch'))!
    const sent = JSON.parse(request.body) as { id: string; type: string; address: string; token: string }
    expect(sent.type).toBe('web_hook')
    expect(sent.address).toBe('https://app.test/drives/google/notify')
    // The secret is the ENGINE's, per subscription — never a value the adapter
    // chose, and never the client secret.
    expect(sent.token).toHaveLength(43)
    expect(sent.token).not.toBe(CLIENT_ID)
    // Google caps the channel's life. Its own `expiration` wins over the TTL we
    // asked for: believing our own number is how an app renews too late and
    // silently stops receiving notifications.
    expect(watch.expiresAt).toBe(Date.parse('2026-06-02T00:00:00Z'))
    expect(watch.expiresAt).toBeLessThan(h.now() + 7 * 24 * 60 * 60_000)
    // The subscription is stored with the connection, and the secret is never
    // in the view.
    expect((await h.drives.get(view.id)).watching).toBe(true)
    expect(JSON.stringify(await h.drives.get(view.id))).not.toContain(sent.token)
  })

  it('takes a page token first, because changes.watch needs one', async () => {
    const h = harness()
    const view = await connect(h)
    await watchConnection(h.drives, view.id, { notificationUrl: 'https://app.test/hook' })

    expect(h.google.requests.some((r) => r.url.includes('/changes/startPageToken'))).toBe(true)
    expect(new URL(h.google.requests.find((r) => r.url.includes('/changes/watch'))!.url).searchParams.get('pageToken')).toBeTruthy()
  })

  it('refuses a non-https notification URL', async () => {
    const h = harness()
    const view = await connect(h)
    await expect(
      watchConnection(h.drives, view.id, { notificationUrl: 'http://app.test/hook' }),
    ).rejects.toThrow(/must be https/)
  })

  it('does not persist the resourceUri, only the resourceId', async () => {
    const h = harness()
    const view = await connect(h)
    await watchConnection(h.drives, view.id, { notificationUrl: 'https://app.test/hook' })

    const stored = (await h.store.find('default', view.id))!
    // `resourceUri` embeds the page token — a URL that grants access to the
    // feed does not belong in a row that gets read for display.
    expect(stored.watch?.raw).toEqual({ resourceId: expect.stringMatching(/^resource-/) })
    expect(JSON.stringify(stored.watch?.raw)).not.toContain('pageToken')
  })

  it('stops the channel on disconnect, with the id AND the resource id', async () => {
    const h = harness()
    const view = await connect(h)
    const watch = await watchConnection(h.drives, view.id, { notificationUrl: 'https://app.test/hook' })
    expect(h.google.channels.size).toBe(1)

    await h.drives.disconnect(view.id)

    const stop = h.google.requests.find((r) => r.url.includes('/channels/stop'))!
    expect(JSON.parse(stop.body)).toEqual({ id: watch.id, resourceId: expect.stringMatching(/^resource-/) })
    expect(h.google.channels.size).toBe(0)
  })
})

describe('verifying a notification', () => {
  it('extracts the channel token and the channel id', () => {
    const result = provider.verifyNotification({
      method: 'POST',
      headers: {
        'x-goog-channel-id': 'channel-1',
        'x-goog-channel-token': 'the-secret',
        'x-goog-resource-state': 'change',
      },
      query: {},
      body: Buffer.alloc(0),
    })
    // Google does not sign anything: the token WE chose at subscribe time is
    // the whole of the authentication, and the engine compares it in constant
    // time against the connection's stored secret.
    expect(result).toEqual({ secret: 'the-secret', watchId: 'channel-1', changed: true })
  })

  it('reports the initial sync message as no-change', () => {
    const result = provider.verifyNotification({
      method: 'POST',
      headers: { 'x-goog-channel-token': 's', 'x-goog-resource-state': 'sync' },
      query: {},
      body: Buffer.alloc(0),
    })
    // Sent immediately after `changes.watch` to say the channel is live. It is
    // authentic and means nothing has changed yet.
    expect(result.changed).toBe(false)
  })

  it('fails closed when there is no channel token', () => {
    // Without it nothing authenticates the call, and accepting it would hand an
    // unauthenticated caller a sync trigger.
    expect(() =>
      provider.verifyNotification({
        method: 'POST',
        headers: { 'x-goog-channel-id': 'channel-1', 'x-goog-resource-state': 'change' },
        query: {},
        body: Buffer.alloc(0),
      }),
    ).toThrow(/no channel token/)
  })

  it('bounds the channel token', () => {
    expect(() =>
      provider.verifyNotification({
        method: 'POST',
        headers: { 'x-goog-channel-token': 'x'.repeat(300) },
        query: {},
        body: Buffer.alloc(0),
      }),
    ).toThrow(/too long/)
  })

  it('refuses anything that is not a POST', () => {
    // Google has no GET handshake — it verifies the domain out of band, in the
    // Cloud console — so there is no `challenge` to echo here at all.
    expect(() =>
      provider.verifyNotification({ method: 'GET', headers: { challenge: 'x' }, query: { challenge: 'x' }, body: Buffer.alloc(0) }),
    ).toThrow(/POSTs/)
  })

  it('is pure: no session, no network', () => {
    const before = provider.verifyNotification({
      method: 'POST',
      headers: { 'x-goog-channel-token': 's' },
      query: {},
      body: Buffer.alloc(0),
    })
    // Hammering the webhook route cannot be amplified into provider traffic.
    expect(before.changed).toBe(true)
    expect(provider.verifyNotification.length).toBe(1)
  })
})

describe('resolving a notification to a connection', () => {
  it('matches the connection that holds the channel secret', async () => {
    const h = harness()
    const view = await connect(h)
    const watch = await watchConnection(h.drives, view.id, { notificationUrl: 'https://app.test/hook' })
    const connections = await h.store.list('default')

    const outcome = await handleNotification(h.drives, h.google.notificationFor(watch.id), {
      provider: 'google',
      connections,
    })

    expect(outcome.shouldSync).toBe(true)
    expect(outcome.connections.map((c) => c.id)).toEqual([view.id])
  })

  it('cannot be made to sync a connection by guessing its id', async () => {
    const h = harness()
    const view = await connect(h)
    const watch = await watchConnection(h.drives, view.id, { notificationUrl: 'https://app.test/hook' })
    const connections = await h.store.list('default')

    const forged = h.google.notificationFor(watch.id, { token: 'not-the-secret' })
    const outcome = await handleNotification(h.drives, forged, { provider: 'google', connections })

    // A verified-but-unmatched notification gets the same uniform answer as a
    // matched one: a different answer is an oracle for which channels a
    // deployment holds.
    expect(outcome.shouldSync).toBe(false)
    expect(outcome.reason).toBe('unmatched')
    expect(outcome.connections).toHaveLength(0)
  })

  it('answers the sync message without scheduling anything', async () => {
    const h = harness()
    const view = await connect(h)
    const watch = await watchConnection(h.drives, view.id, { notificationUrl: 'https://app.test/hook' })
    const connections = await h.store.list('default')

    const outcome = await handleNotification(h.drives, h.google.notificationFor(watch.id, { state: 'sync' }), {
      provider: 'google',
      connections,
    })

    expect(outcome.reason).toBe('no-change')
    expect(outcome.shouldSync).toBe(false)
  })

  it('collapses a replayed delivery on the message number', async () => {
    const h = harness()
    const view = await connect(h)
    const watch = await watchConnection(h.drives, view.id, { notificationUrl: 'https://app.test/hook' })
    const connections = await h.store.list('default')
    const replayGuard = new MemoryReplayGuard(h.now)
    const notification = h.google.notificationFor(watch.id, { messageNumber: 7 })

    const first = await handleNotification(h.drives, notification, { provider: 'google', connections, replayGuard })
    const second = await handleNotification(h.drives, notification, { provider: 'google', connections, replayGuard })

    expect(first.shouldSync).toBe(true)
    // `X-Goog-Message-Number` is a per-channel counter, which is what makes a
    // replay identifiable at all — Google re-delivers on any non-2xx.
    expect(second.shouldSync).toBe(false)
    expect(second.reason).toBe('replay')
  })
})
