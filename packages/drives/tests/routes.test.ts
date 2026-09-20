import { describe, expect, it } from 'vitest'
import { runRoute, type BasaltRoute, type HttpReply, type HttpRequest } from '@basaltkit/http'
import { driveRoutes, notificationBytes, readCookie } from '../src/routes.js'
import { DriveNotificationInvalidError } from '../src/errors.js'
import type { DriveConnection } from '../src/store.js'
import { connect, harness, type Harness } from './helpers.js'

const REDIRECT = 'https://app.test/drives/fake/callback'

class Recorder implements HttpReply {
  status = 200
  payload: unknown
  headers: Record<string, string> = {}
  private _sent = false
  get sent(): boolean {
    return this._sent
  }
  get statusCode(): number {
    return this.status
  }
  get raw(): unknown {
    return this
  }
  code(status: number): this {
    this.status = status
    return this
  }
  header(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value
    return this
  }
  send(payload?: unknown): this {
    this._sent = true
    this.payload = payload
    return this
  }
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    url: '/',
    headers: {},
    params: {},
    query: {},
    body: undefined,
    raw: {},
    ...overrides,
  }
}

/**
 * Calls a route the way an adapter does. A `body` given as bytes is handed
 * over as `bodyBytes` — that is the contract `rawBody()` routes are served
 * under, and passing a parsed object instead is exactly what must not work.
 */
async function call(definition: BasaltRoute, input: Partial<HttpRequest>): Promise<Recorder> {
  const reply = new Recorder()
  const { body, ...rest } = input
  const framed: Partial<HttpRequest> =
    Buffer.isBuffer(body) || typeof body === 'string'
      ? { ...rest, bodyBytes: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8') }
      : input
  const result = await runRoute(definition, request(framed), reply, { enrichers: [], guards: [] })
  if (!reply.sent && result !== undefined) reply.send(result)
  return reply
}

function routesFor(h: Harness, overrides: Partial<Parameters<typeof driveRoutes>[0]> = {}) {
  return driveRoutes({
    drives: h.drives,
    redirectUri: REDIRECT,
    meta: {},
    ...overrides,
  })
}

const byUrl = (routes: BasaltRoute[], method: string, url: string): BasaltRoute =>
  routes.find((r) => r.method === method && r.url === url)!

describe('driveRoutes — shape', () => {
  it('guards the connect flow by default and never guards the notification endpoint', () => {
    const h = harness()
    const routes = driveRoutes({
      drives: h.drives,
      redirectUri: REDIRECT,
      notifications: { connections: [], onChange: () => {} },
    })
    // Starting an authorization on behalf of a tenant is not an anonymous
    // action; a provider calling the webhook has no session at all.
    expect(byUrl(routes, 'GET', '/drives/:provider/connect').meta).toEqual({ auth: true })
    expect(byUrl(routes, 'GET', '/drives/:provider/callback').meta).toEqual({ auth: true })
    expect(byUrl(routes, 'POST', '/drives/:provider/notifications').meta).toBeUndefined()
    expect(byUrl(routes, 'GET', '/drives/:provider/notifications').meta).toBeUndefined()
  })

  it('serves only the connect flow when no notification options are given', () => {
    const routes = routesFor(harness())
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /drives/:provider/connect',
      'GET /drives/:provider/callback',
    ])
  })
})

describe('the connect route', () => {
  it('redirects to the provider and binds the flow to a hardened cookie', async () => {
    const h = harness()
    const reply = await call(byUrl(routesFor(h), 'GET', '/drives/:provider/connect'), {
      params: { provider: 'fake' },
      query: { label: 'Drive Finance' },
    })

    expect(reply.status).toBe(302)
    expect(reply.headers['location']).toContain('https://fake-drive.test/oauth/authorize')
    expect(reply.headers['cache-control']).toBe('no-store')
    const cookie = reply.headers['set-cookie']!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    // Scoped to the flow, not to the whole origin.
    expect(cookie).toContain('Path=/drives/fake')
    expect(cookie).toContain('Max-Age=600')
  })

  it('strips control characters out of a label before it is ever stored', async () => {
    const h = harness()
    const connectRoute = byUrl(routesFor(h), 'GET', '/drives/:provider/connect')
    const started = await call(connectRoute, {
      params: { provider: 'fake' },
      query: { label: 'Drive\u202eFinance\u0000' },
    })
    const cookie = decodeCookie(started.headers['set-cookie']!)
    expect(cookie.l).toBe('DriveFinance')
  })

  it('refuses a redirect URI that is not usable as one', () => {
    const h = harness()
    const routes = routesFor(h, { redirectUri: 'http://app.example.com/cb' })
    // An http redirect on a real host is a token on the wire; the flow refuses
    // before the browser is ever sent anywhere.
    return expect(
      call(byUrl(routes, 'GET', '/drives/:provider/connect'), { params: { provider: 'fake' } }),
    ).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })

  it('leaves the cookie insecure only for a localhost redirect, and only on request', async () => {
    const local = harness()
    const reply = await call(
      byUrl(routesFor(local, { redirectUri: 'http://localhost:3000/cb', cookie: { secure: false } }), 'GET', '/drives/:provider/connect'),
      { params: { provider: 'fake' } },
    )
    expect(reply.headers['set-cookie']).not.toContain('Secure')

    const remote = harness()
    const production = await call(
      byUrl(routesFor(remote, { cookie: { secure: false } }), 'GET', '/drives/:provider/connect'),
      { params: { provider: 'fake' } },
    )
    // A config flag must not be able to put an OAuth binding on the wire in clear.
    expect(production.headers['set-cookie']).toContain('Secure')
  })
})

describe('the callback route', () => {
  async function started(h: Harness) {
    const routes = routesFor(h)
    const reply = await call(byUrl(routes, 'GET', '/drives/:provider/connect'), {
      params: { provider: 'fake' },
      query: { label: 'Drive Finance' },
    })
    const state = new URL(reply.headers['location']!).searchParams.get('state')!
    const cookieHeader = reply.headers['set-cookie']!
    const cookie = cookieHeader.slice(0, cookieHeader.indexOf(';'))
    return { routes, state, cookie }
  }

  it('completes the flow and clears the cookie', async () => {
    const h = harness()
    const { routes, state, cookie } = await started(h)
    const reply = await call(byUrl(routes, 'GET', '/drives/:provider/callback'), {
      params: { provider: 'fake' },
      query: { code: 'good', state },
      headers: { cookie },
    })

    expect(reply.status).toBe(200)
    expect((reply.payload as { label: string }).label).toBe('Drive Finance')
    expect(reply.headers['set-cookie']).toContain('Max-Age=0')
    expect(reply.headers['cache-control']).toBe('no-store')
  })

  it('redirects when the app configured a destination', async () => {
    const h = harness()
    const routes = routesFor(h, { successRedirect: '/settings/drives' })
    const start = await call(byUrl(routes, 'GET', '/drives/:provider/connect'), { params: { provider: 'fake' } })
    const state = new URL(start.headers['location']!).searchParams.get('state')!
    const header = start.headers['set-cookie']!
    const reply = await call(byUrl(routes, 'GET', '/drives/:provider/callback'), {
      params: { provider: 'fake' },
      query: { code: 'good', state },
      headers: { cookie: header.slice(0, header.indexOf(';')) },
    })
    expect(reply.status).toBe(302)
    expect(reply.headers['location']).toBe('/settings/drives')
  })

  it('refuses a callback whose browser did not start the flow', async () => {
    const h = harness()
    const { routes, state } = await started(h)
    // The state alone is replayable into a victim's session; a state that only
    // verifies against a value in the victim's own cookie jar is not.
    await expect(
      call(byUrl(routes, 'GET', '/drives/:provider/callback'), {
        params: { provider: 'fake' },
        query: { code: 'good', state },
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })

  it('refuses a replayed callback', async () => {
    const h = harness()
    const { routes, state, cookie } = await started(h)
    const query = { code: 'good', state }
    await call(byUrl(routes, 'GET', '/drives/:provider/callback'), {
      params: { provider: 'fake' },
      query,
      headers: { cookie },
    })
    await expect(
      call(byUrl(routes, 'GET', '/drives/:provider/callback'), {
        params: { provider: 'fake' },
        query,
        headers: { cookie },
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })

  it('does not forward the provider’s own error text', async () => {
    const h = harness()
    const { routes } = await started(h)
    await expect(
      call(byUrl(routes, 'GET', '/drives/:provider/callback'), {
        params: { provider: 'fake' },
        query: { error: 'access_denied', error_description: '<script>alert(1)</script>' },
      }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining('script') })
  })
})

describe('the notification route', () => {
  async function watched() {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    const { watchConnection } = await import('../src/notifications.js')
    const watch = await watchConnection(h.drives, view.id, {
      tenantId: 'acme',
      notificationUrl: 'https://app.test/drives/fake/notifications',
    })
    const connections = [(await h.store.find('acme', view.id))!]
    return { h, view, watch, connections }
  }

  function routes(h: Harness, connections: readonly DriveConnection[], synced: DriveConnection[][]) {
    return routesFor(h, {
      notifications: {
        connections,
        onChange: (matched) => void synced.push([...matched]),
      },
    })
  }

  it('answers a challenge as inert text/plain, touching no connection', async () => {
    const { h, connections } = await watched()
    const synced: DriveConnection[][] = []
    const reply = await call(byUrl(routes(h, connections, synced), 'GET', '/drives/:provider/notifications'), {
      method: 'GET',
      params: { provider: 'fake' },
      query: { challenge: '<img src=x onerror=alert(1)>' },
    })

    expect(reply.status).toBe(200)
    expect(reply.payload).toBe('<img src=x onerror=alert(1)>')
    expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8')
    // Without nosniff a browser decides this is HTML and runs it on our origin.
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(synced).toEqual([])
  })

  it('schedules a sync for a verified notification', async () => {
    const { h, watch, connections, view } = await watched()
    const synced: DriveConnection[][] = []
    const notification = h.fake.notificationFor(watch.id)
    const reply = await call(byUrl(routes(h, connections, synced), 'POST', '/drives/:provider/notifications'), {
      method: 'POST',
      params: { provider: 'fake' },
      headers: notification.headers,
      body: notification.body,
    })

    expect(reply.status).toBe(200)
    expect(reply.payload).toEqual({ received: true })
    expect(synced.flat().map((c) => c.id)).toEqual([view.id])
  })

  it('answers an unmatched notification identically to a matched one', async () => {
    const { h, watch, connections } = await watched()
    const matchedSync: DriveConnection[][] = []
    const unmatchedSync: DriveConnection[][] = []
    const notification = h.fake.notificationFor(watch.id)
    const input = {
      method: 'POST',
      params: { provider: 'fake' },
      headers: notification.headers,
      body: notification.body,
    }

    const matched = await call(byUrl(routes(h, connections, matchedSync), 'POST', '/drives/:provider/notifications'), input)
    const unmatched = await call(byUrl(routes(h, [], unmatchedSync), 'POST', '/drives/:provider/notifications'), input)

    // Byte-identical on the wire. The only difference is that one scheduled work.
    expect(unmatched.status).toBe(matched.status)
    expect(unmatched.payload).toEqual(matched.payload)
    expect(unmatchedSync).toEqual([])
  })

  it('rejects a notification that fails verification', async () => {
    const { h, watch, connections } = await watched()
    const forged = h.fake.notificationFor(watch.id)
    forged.headers['x-fake-channel-token'] = 'guessed'
    await expect(
      call(byUrl(routes(h, connections, []), 'POST', '/drives/:provider/notifications'), {
        method: 'POST',
        params: { provider: 'fake' },
        headers: forged.headers,
        body: forged.body,
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_NOTIFICATION_INVALID' })
  })

  it('refuses a GET that is not a handshake', async () => {
    const { h, connections } = await watched()
    await expect(
      call(byUrl(routes(h, connections, []), 'GET', '/drives/:provider/notifications'), {
        method: 'GET',
        params: { provider: 'fake' },
        query: {},
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_NOTIFICATION_INVALID' })
  })
})

describe('the POST handshake (Microsoft Graph shape)', () => {
  /**
   * Graph validates a subscription URL with a **POST** that carries the token
   * in the query and **no body at all** — the subscription does not exist yet,
   * and there is nothing to sign. Demanding the bytes first turns that into a
   * refusal, and the operator sees `subscriptionValidationFailed` on `watch()`,
   * which points at the subscription rather than at the body parser.
   */
  async function graphRoutes(seen: string[] = []) {
    const h = harness()
    return {
      seen,
      routes: routesFor(h, {
        notifications: {
          // A handshake must be answered without consulting any connection —
          // so this resolver must never run.
          connections: () => {
            seen.push('connections')
            return []
          },
          onChange: () => void seen.push('onChange'),
        },
      }),
    }
  }

  const post = (routes: BasaltRoute[]) => byUrl(routes, 'POST', '/drives/:provider/notifications')

  it('answers a POST challenge that carries no body whatsoever', async () => {
    const { routes } = await graphRoutes()
    const reply = await call(post(routes), {
      method: 'POST',
      params: { provider: 'fake' },
      query: { challenge: 'validation-token-123' },
      // Deliberately nothing: no bodyBytes, no bodyStream. This is the shape
      // Graph sends, and it must not be mistaken for a missing raw body.
    })
    expect(reply.status).toBe(200)
    expect(reply.payload).toBe('validation-token-123')
    expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.headers['cache-control']).toBe('no-store')
  })

  it('answers it without consulting any connection or subscription', async () => {
    const seen: string[] = []
    const { routes } = await graphRoutes(seen)
    await call(post(routes), {
      method: 'POST',
      params: { provider: 'fake' },
      query: { challenge: 'abc' },
    })
    // Graph validates the URL *before* the subscription exists. Looking
    // anything up would be a lie about what the echo proves — and an oracle
    // for which accounts a deployment holds.
    expect(seen).toEqual([])
  })

  it('caps and sanitises a hostile token instead of reflecting it whole', async () => {
    const { routes } = await graphRoutes()
    const hostile = `<script>alert(1)</script>\u0000\u202e${'A'.repeat(600)}`
    const reply = await call(post(routes), {
      method: 'POST',
      params: { provider: 'fake' },
      query: { challenge: hostile },
    })
    const echoed = reply.payload as string
    expect(echoed.length).toBeLessThanOrEqual(256)
    // Inert by headers (text/plain + nosniff), and with the control and bidi
    // characters that make a reflected value dangerous in a log or a terminal
    // removed.
    expect(echoed).not.toContain('\u0000')
    expect(echoed).not.toContain('\u202e')
    expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
  })

  it('still demands the bytes for a delivery that declared them', async () => {
    const { routes } = await graphRoutes()
    // No challenge in the query: this is a delivery. It declared a body, so
    // the bytes it was signed over are required and their absence is refused,
    // exactly as before — the handshake shortcut widens nothing.
    await expect(
      call(post(routes), {
        method: 'POST',
        params: { provider: 'fake' },
        query: {},
        headers: { 'x-fake-signature': 'fake-signature', 'content-length': '18' },
      }),
    ).rejects.toMatchObject({ code: 'RAW_BODY_UNAVAILABLE' })
  })

  it('refuses a bodiless POST that is not a handshake, as a bad delivery', async () => {
    const { routes } = await graphRoutes()
    // Nothing declared and nothing to echo: the empty body reaches the
    // provider, which rejects it as the malformed delivery it is — a flat 400,
    // not a raw-body complaint that would send the operator hunting.
    await expect(
      call(post(routes), {
        method: 'POST',
        params: { provider: 'fake' },
        query: {},
        headers: { 'x-fake-signature': 'fake-signature' },
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_NOTIFICATION_INVALID' })
  })

  it('does not let a query turn an unverifiable delivery into a 200', async () => {
    const { routes } = await graphRoutes()
    // A query that is not a challenge must not short-circuit anything: the
    // route falls through to the bytes, and the bad signature still wins.
    await expect(
      call(post(routes), {
        method: 'POST',
        params: { provider: 'fake' },
        query: { tenant: 'acme' },
        headers: { 'x-fake-signature': 'guessed' },
        body: Buffer.from('{"accounts":["a"]}'),
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_NOTIFICATION_INVALID' })
  })
})

describe('notificationBytes', () => {
  const raw = (bytes: Buffer | string) => ({
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'),
    contentType: 'application/json',
    contentLength: undefined,
    text: () => (Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes),
  })

  it('takes the octets rawBody() delivered, whatever they are', () => {
    const payload = Buffer.from('{  "b" : 2,\n "a":1 }', 'utf8')
    expect(notificationBytes(raw(payload), request(), undefined, 1024)).toEqual(payload)
  })

  it('prefers an explicit resolver over everything else', () => {
    expect(
      notificationBytes(raw('delivered'), request(), () => Buffer.from('explicit'), 1024).toString(),
    ).toBe('explicit')
  })

  it('fails closed rather than re-serialising a parsed object', () => {
    // The whole point. `JSON.stringify(parsed)` produces different bytes, so a
    // correct signature would look wrong — and a route that shrugged that off
    // would accept anything. A parsed body is not a source of bytes, here or
    // anywhere else in this route.
    expect(() =>
      notificationBytes(undefined, request({ body: { list_folder: { accounts: ['a'] } } }), undefined, 1024),
    ).toThrow(DriveNotificationInvalidError)
  })

  it('ignores a resolver that returns nothing rather than guessing', () => {
    expect(() => notificationBytes(undefined, request(), () => undefined, 1024)).toThrow(
      DriveNotificationInvalidError,
    )
  })

  it('refuses a body over the cap', () => {
    expect(() => notificationBytes(raw(Buffer.alloc(2048)), request(), undefined, 1024)).toThrow(
      DriveNotificationInvalidError,
    )
  })
})

function decodeCookie(header: string): { b: string; l: string; r?: string } {
  const value = decodeURIComponent(header.slice(header.indexOf('=') + 1, header.indexOf(';')))
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { b: string; l: string; r?: string }
}

describe('cookie reading', () => {
  const withCookie = (header: string | string[] | undefined): HttpRequest =>
    request({ headers: header === undefined ? {} : { cookie: header } })

  it('picks one cookie out of a crowded header', () => {
    expect(readCookie(withCookie('a=1; bk_drive_connect=wanted; z=9'), 'bk_drive_connect')).toBe('wanted')
  })

  it('joins a repeated Cookie header rather than reading only the first', () => {
    expect(readCookie(withCookie(['a=1', 'bk_drive_connect=wanted']), 'bk_drive_connect')).toBe('wanted')
  })

  it('percent-decodes, and survives a value that is not valid encoding', () => {
    expect(readCookie(withCookie('c=a%20b'), 'c')).toBe('a b')
    expect(readCookie(withCookie('c=%E0%A4%A'), 'c')).toBe('%E0%A4%A')
  })

  it('returns nothing for a missing, malformed or absent header', () => {
    expect(readCookie(withCookie(undefined), 'c')).toBeUndefined()
    expect(readCookie(withCookie('novalue; other=1'), 'c')).toBeUndefined()
    expect(readCookie(withCookie('c2=1'), 'c')).toBeUndefined()
  })
})

describe('a tampered connect cookie', () => {
  it('is treated as absent rather than trusted', async () => {
    const h = harness()
    const routes = routesFor(h)
    const start = await call(byUrl(routes, 'GET', '/drives/:provider/connect'), { params: { provider: 'fake' } })
    const state = new URL(start.headers['location']!).searchParams.get('state')!

    // Garbage, valid base64url of non-JSON, and JSON without a binding: none
    // of them may stand in for the value that proves this browser started the
    // flow.
    for (const value of ['not-base64url!!', Buffer.from('nope').toString('base64url'), Buffer.from('{"l":"x"}').toString('base64url')]) {
      await expect(
        call(byUrl(routes, 'GET', '/drives/:provider/callback'), {
          params: { provider: 'fake' },
          query: { code: 'good', state },
          headers: { cookie: `bk_drive_connect=${value}` },
        }),
      ).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
    }
  })
})

describe('a query an adapter shaped differently', () => {
  it('reads a repeated query parameter as its first value', async () => {
    const h = harness()
    const { watchConnection } = await import('../src/notifications.js')
    const view = await connect(h, { tenantId: 'acme' })
    await watchConnection(h.drives, view.id, { tenantId: 'acme', notificationUrl: 'https://app.test/hook' })
    const routes = routesFor(h, {
      notifications: { connections: [], onChange: () => {} },
    })

    const reply = await call(byUrl(routes, 'GET', '/drives/:provider/notifications'), {
      method: 'GET',
      params: { provider: 'fake' },
      // Express hands `?challenge=a&challenge=b` over as an array.
      query: { challenge: ['first', 'second'], ignored: 7 },
    })
    expect(reply.payload).toBe('first')
  })
})

describe('the secure-cookie decision', () => {
  it('keeps Secure for a redirect URI that is not even a URL', async () => {
    const h = harness()
    // `assertRedirectUri` refuses it first, so the flow never reaches a cookie
    // — which is itself the property worth pinning.
    await expect(
      call(byUrl(routesFor(h, { redirectUri: 'not a url' }), 'GET', '/drives/:provider/connect'), {
        params: { provider: 'fake' },
      }),
    ).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })
})
