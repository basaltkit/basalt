import { describe, expect, it } from 'vitest'
import { HttpServerCollector, MemoryRateLimitStore, securityPlugin } from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

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
