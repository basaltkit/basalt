import { definePlugin, ensureMetadata } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CSP, HttpServerCollector, MemoryRateLimitStore, securityPlugin } from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

/** Publishes routes into the `http:routes` metadata bucket, the way an adapter does,
 *  so the security plugin can read per-route `meta.rateLimit` overrides. */
const routesProvider = (routes: { url: string; meta?: Record<string, unknown> }[]) =>
  definePlugin({
    name: 'test:routes',
    boot({ container }) {
      const metadata = ensureMetadata(container)
      for (const route of routes) metadata.add('http:routes', route)
    },
  })

describe('MemoryRateLimitStore', () => {
  it('counts hits, reports remaining, and blocks past the limit', () => {
    const now = 1000
    const store = new MemoryRateLimitStore(() => now)
    expect(store.hit('k', 2, 1000)).toMatchObject({ allowed: true, remaining: 1 })
    expect(store.hit('k', 2, 1000)).toMatchObject({ allowed: true, remaining: 0 })
    const third = store.hit('k', 2, 1000)
    expect(third.allowed).toBe(false)
    expect(third.retryAfterMs).toBeGreaterThan(0)
  })

  it('opens a fresh window after the current one elapses', () => {
    let now = 1000
    const store = new MemoryRateLimitStore(() => now)
    store.hit('k', 1, 100)
    expect(store.hit('k', 1, 100).allowed).toBe(false)
    now += 200
    expect(store.hit('k', 1, 100).allowed).toBe(true)
  })

  it('reset() clears a key', () => {
    const store = new MemoryRateLimitStore()
    store.hit('k', 1, 1000)
    expect(store.hit('k', 1, 1000).allowed).toBe(false)
    store.reset('k')
    expect(store.hit('k', 1, 1000).allowed).toBe(true)
  })
})

describe('securityPlugin', () => {
  it('applies secure response headers by default', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin()])
    const reply = new FakeReply()
    await c.runPre(makeRequest(), reply)
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.headers['x-frame-options']).toBe('DENY')
    expect(reply.headers['referrer-policy']).toBe('no-referrer')
    expect(reply.headers['strict-transport-security']).toContain('max-age=')
  })

  it('emits a restrictive default CSP when none is supplied', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin()])
    const reply = new FakeReply()
    await c.runPre(makeRequest(), reply)
    expect(reply.headers['content-security-policy']).toBe(DEFAULT_CSP)
    expect(reply.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'")
  })

  it('lets a supplied CSP override the default', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ headers: { contentSecurityPolicy: "default-src 'self'" } })])
    const reply = new FakeReply()
    await c.runPre(makeRequest(), reply)
    expect(reply.headers['content-security-policy']).toBe("default-src 'self'")
  })

  it('omits CSP entirely when contentSecurityPolicy is false', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ headers: { contentSecurityPolicy: false } })])
    const reply = new FakeReply()
    await c.runPre(makeRequest(), reply)
    expect(reply.headers['content-security-policy']).toBeUndefined()
  })

  it('applies a stricter per-route meta.rateLimit while other routes use the global limit', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [
      routesProvider([
        { url: '/login', meta: { rateLimit: { limit: 1, windowMs: 1000 } } },
        { url: '/items' },
      ]),
      securityPlugin({ rateLimit: { limit: 5, windowMs: 1000 } }),
    ])

    // /login is capped at its own limit of 1 — the second hit is blocked.
    const login1 = new FakeReply()
    expect(await c.runPre(makeRequest({ ip: '1.1.1.1', routePattern: '/login' }), login1)).toBe(false)
    expect(login1.headers['x-ratelimit-limit']).toBe('1')
    const login2 = new FakeReply()
    expect(await c.runPre(makeRequest({ ip: '1.1.1.1', routePattern: '/login' }), login2)).toBe(true)
    expect(login2.statusCode).toBe(429)

    // The same client on /items still gets the global limit of 5.
    for (let i = 0; i < 5; i++) {
      const ok = new FakeReply()
      expect(await c.runPre(makeRequest({ ip: '1.1.1.1', routePattern: '/items' }), ok)).toBe(false)
    }
    const overGlobal = new FakeReply()
    expect(await c.runPre(makeRequest({ ip: '1.1.1.1', routePattern: '/items' }), overGlobal)).toBe(true)
    expect(overGlobal.statusCode).toBe(429)
  })

  it('answers a CORS preflight with 204 and the negotiated headers', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ cors: { origin: true, methods: ['GET', 'POST'] } })])
    const reply = new FakeReply()
    const sent = await c.runPre(
      makeRequest({
        method: 'OPTIONS',
        headers: { origin: 'https://app.test', 'access-control-request-method': 'POST' },
      }),
      reply,
    )
    expect(sent).toBe(true)
    expect(reply.statusCode).toBe(204)
    expect(reply.headers['access-control-allow-origin']).toBe('https://app.test')
    expect(reply.headers['access-control-allow-methods']).toContain('POST')
  })

  it('restricts CORS to an allow-list', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ cors: { origin: ['https://ok.test'] } })])

    const ok = new FakeReply()
    await c.runPre(makeRequest({ headers: { origin: 'https://ok.test' } }), ok)
    expect(ok.headers['access-control-allow-origin']).toBe('https://ok.test')

    const blocked = new FakeReply()
    await c.runPre(makeRequest({ headers: { origin: 'https://evil.test' } }), blocked)
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rate limits: sets headers, then 429s past the limit', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ rateLimit: { limit: 1, windowMs: 1000 } })])

    const first = new FakeReply()
    expect(await c.runPre(makeRequest({ ip: '1.1.1.1' }), first)).toBe(false)
    expect(first.headers['x-ratelimit-remaining']).toBe('0')

    const second = new FakeReply()
    const blocked = await c.runPre(makeRequest({ ip: '1.1.1.1' }), second)
    expect(blocked).toBe(true)
    expect(second.statusCode).toBe(429)
    expect(second.headers['retry-after']).toBeDefined()
    expect((second.payload as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
  })

  it('separates rate-limit buckets by client key', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ rateLimit: { limit: 1, windowMs: 1000 } })])
    await c.runPre(makeRequest({ ip: '1.1.1.1' }), new FakeReply())
    // a different IP is unaffected by the first one hitting the limit
    const other = new FakeReply()
    expect(await c.runPre(makeRequest({ ip: '2.2.2.2' }), other)).toBe(false)
  })
})
