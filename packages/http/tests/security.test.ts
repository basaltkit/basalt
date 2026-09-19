import { definePlugin, ensureMetadata } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CSP,
  HttpError,
  HttpServerCollector,
  MemoryRateLimitStore,
  route,
  runRoute,
  securityPlugin,
  toErrorResponse,
  type RequestEnricher,
  type RouteGuard,
} from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

/** Publishes routes into the `http:routes` metadata bucket, the way an adapter does,
 *  so the security plugin can read per-route `meta.rateLimit` overrides. */
const routesProvider = (routes: { method?: string; url: string; meta?: Record<string, unknown> }[]) =>
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
    const loginRoute = route({ method: 'POST', url: '/login', meta: { rateLimit: { limit: 1, windowMs: 1000 } }, handler: () => 'ok' })
    const app = await bootWith(c, [
      routesProvider([{ method: 'POST', url: '/login', meta: { rateLimit: { limit: 1, windowMs: 1000 } } }, { method: 'GET', url: '/items' }]),
      securityPlugin({ rateLimit: { limit: 5, windowMs: 1000 } }),
    ])
    const guards = ensureMetadata(app.container).get<RouteGuard>('http:guards')
    const hitLogin = async () => {
      const request = makeRequest({ method: 'POST', ip: '1.1.1.1', url: '/login', routePattern: '/login' })
      const reply = new FakeReply()
      // Fastify knows the route in the pre-hook: it charges /login's own bucket
      // there (the guard then skips it) and never the global one.
      if (await c.runPre(request, reply)) return { status: reply.statusCode, reply }
      try {
        await runRoute(loginRoute, request, reply, { container: app.container, guards })
        return { status: reply.statusCode, reply }
      } catch (error) {
        return { status: toErrorResponse(error).status, reply }
      }
    }

    // /login is capped at its own limit of 1 — the second hit is blocked.
    const login1 = await hitLogin()
    expect(login1.status).toBe(200)
    expect(login1.reply.headers['x-ratelimit-limit']).toBe('1')
    const login2 = await hitLogin()
    expect(login2.status).toBe(429)
    expect(login2.reply.headers['retry-after']).toBeDefined()

    // The same client on /items still gets the global limit of 5, untouched by /login.
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

describe('MemoryRateLimitStore bounds its memory (expired buckets never pile up)', () => {
  it('sweeps expired buckets so distinct one-off clients do not accumulate forever', () => {
    let now = 0
    const store = new MemoryRateLimitStore({ clock: () => now })
    // Many distinct clients (think rotating IPv6 addresses), one hit each.
    for (let i = 0; i < 5_000; i++) store.hit(`ip-${i}`, 10, 1_000)
    // Long after every window has expired, a single new hit reclaims them.
    now += 10 * 60_000
    store.hit('late', 10, 1_000)
    expect(store.size).toBe(1)
  })

  it('caps live buckets at maxEntries, evicting the oldest first', () => {
    const now = 0
    const store = new MemoryRateLimitStore({ clock: () => now, maxEntries: 100 })
    for (let i = 0; i < 1_000; i++) store.hit(`ip-${i}`, 10, 60_000)
    expect(store.size).toBeLessThanOrEqual(100)
    // The newest bucket is kept and keeps counting.
    expect(store.hit('ip-999', 1, 60_000).allowed).toBe(false)
  })

  it('still accepts a plain clock function (backwards compatible constructor)', () => {
    const now = 5
    const store = new MemoryRateLimitStore(() => now)
    expect(store.hit('k', 1, 10).resetAt).toBe(15)
  })
})

describe('per-route meta.rateLimit is enforced on every adapter (not only when the pre-hook knows the route)', () => {
  // Express and Hono run the neutral pre-hook before routing, so the request
  // carries no `routePattern`. The override must still be enforced — through the
  // route guard, which always sees the route definition.
  const login = route({
    method: 'POST',
    url: '/login',
    meta: { rateLimit: { limit: 2, windowMs: 60_000 } },
    handler: () => ({ ok: true }),
  })

  async function attempt(app: Awaited<ReturnType<typeof bootWith>>, c: HttpServerCollector, ip: string) {
    const request = makeRequest({ method: 'POST', url: '/login', ip }) // no routePattern (Express/Hono)
    const reply = new FakeReply()
    if (await c.runPre(request, reply)) return { status: reply.statusCode, reply }
    try {
      await runRoute(login, request, reply, {
        container: app.container,
        enrichers: ensureMetadata(app.container).get<RequestEnricher>('http:enrichers'),
        guards: ensureMetadata(app.container).get<RouteGuard>('http:guards'),
      })
      return { status: reply.statusCode, reply }
    } catch (error) {
      return { status: toErrorResponse(error).status, reply, error }
    }
  }

  it('blocks the third login attempt with 429 even though the pre-hook had no routePattern', async () => {
    const c = new HttpServerCollector()
    const app = await bootWith(c, [securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 } })])
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await attempt(app, c, '9.9.9.9')).status)
    expect(statuses).toEqual([200, 200, 429, 429, 429])
    const blocked = await attempt(app, c, '9.9.9.9')
    expect(toErrorResponse(blocked.error).body.error.code).toBe('RATE_LIMITED')
    expect(blocked.reply.headers['retry-after']).toBeDefined()
    expect(blocked.reply.headers['x-ratelimit-limit']).toBe('2')
  })

  it('keeps per-route buckets separate per client', async () => {
    const c = new HttpServerCollector()
    const app = await bootWith(c, [securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 } })])
    for (let i = 0; i < 3; i++) await attempt(app, c, '1.1.1.1')
    expect((await attempt(app, c, '2.2.2.2')).status).toBe(200)
  })

  it('counts a request once per bucket when the pre-hook does know the route (Fastify)', async () => {
    const c = new HttpServerCollector()
    const app = await bootWith(c, [
      routesProvider([{ method: 'POST', url: '/login', meta: login.meta! }]),
      // A global budget of 2 would 429 the third request if /login were also
      // counted globally — it must not be, when the route is known up front.
      securityPlugin({ rateLimit: { limit: 2, windowMs: 60_000 } }),
    ])
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      const request = makeRequest({ method: 'POST', url: '/login', ip: '3.3.3.3', routePattern: '/login' })
      const reply = new FakeReply()
      if (await c.runPre(request, reply)) {
        statuses.push(reply.statusCode)
        continue
      }
      try {
        await runRoute(login, request, reply, {
          container: app.container,
          guards: ensureMetadata(app.container).get<RouteGuard>('http:guards'),
        })
        statuses.push(reply.statusCode)
      } catch (error) {
        statuses.push(toErrorResponse(error).status)
      }
    }
    expect(statuses).toEqual([200, 200, 429])
    // The global bucket was never touched by /login.
    const other = new FakeReply()
    expect(await c.runPre(makeRequest({ ip: '3.3.3.3', routePattern: '/items' }), other)).toBe(false)
    expect(other.headers['x-ratelimit-remaining']).toBe('1')
  })

  it('honours skip() for per-route limits too', async () => {
    const c = new HttpServerCollector()
    const app = await bootWith(c, [
      securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000, skip: (r) => r.ip === '7.7.7.7' } }),
    ])
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await attempt(app, c, '7.7.7.7')).status)
    expect(statuses).toEqual([200, 200, 200, 200])
  })
})

describe('securityPlugin marks responses non-cacheable by default (tokens, API keys, MFA secrets)', () => {
  it('sends Cache-Control: no-store by default', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin()])
    const reply = new FakeReply()
    await c.runPre(makeRequest({ method: 'POST', url: '/auth/login' }), reply)
    expect(reply.headers['cache-control']).toBe('no-store')
  })

  it('lets the app choose its own Cache-Control value or omit it', async () => {
    const custom = new HttpServerCollector()
    await bootWith(custom, [securityPlugin({ headers: { cacheControl: 'private, no-cache' } })])
    const r1 = new FakeReply()
    await custom.runPre(makeRequest(), r1)
    expect(r1.headers['cache-control']).toBe('private, no-cache')

    const off = new HttpServerCollector()
    await bootWith(off, [securityPlugin({ headers: { cacheControl: false } })])
    const r2 = new FakeReply()
    await off.runPre(makeRequest(), r2)
    expect(r2.headers['cache-control']).toBeUndefined()
  })
})

describe('per-route rate limits cannot be sidestepped when the pre-hook knows the route (Fastify)', () => {
  const loginPost = route({
    method: 'POST',
    url: '/login',
    meta: { rateLimit: { limit: 2, windowMs: 60_000 } },
    handler: () => ({ ok: true }),
  })
  const loginGet = route({ method: 'GET', url: '/login', handler: () => ({ form: true }) })

  async function fastifyAttempt(
    app: Awaited<ReturnType<typeof bootWith>>,
    c: HttpServerCollector,
    definition: typeof loginPost,
  ): Promise<number> {
    // Fastify: the pre-hook runs after routing, so it carries the route pattern,
    // and the adapter hands the same native request (`raw`) to the pipeline.
    const raw = {}
    const request = makeRequest({ method: definition.method, url: definition.url, ip: '4.4.4.4', routePattern: definition.url, raw })
    const reply = new FakeReply()
    if (await c.runPre(request, reply)) return reply.statusCode
    try {
      await runRoute(definition, { ...request }, reply, {
        container: app.container,
        enrichers: ensureMetadata(app.container).get<RequestEnricher>('http:enrichers'),
        guards: ensureMetadata(app.container).get<RouteGuard>('http:guards'),
      })
      return reply.statusCode
    } catch (error) {
      return toErrorResponse(error).status
    }
  }

  it('keeps the global limit on another method of a url that has a per-route limit', async () => {
    const c = new HttpServerCollector()
    const app = await bootWith(c, [
      routesProvider([
        { method: 'POST', url: '/login', meta: loginPost.meta! },
        { method: 'GET', url: '/login', meta: {} },
      ]),
      securityPlugin({ rateLimit: { limit: 2, windowMs: 60_000 } }),
    ])
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push(await fastifyAttempt(app, c, loginGet))
    expect(statuses).toEqual([200, 200, 429, 429, 429])
  })

  it('counts requests rejected by an enricher against the per-route budget', async () => {
    const c = new HttpServerCollector()
    const rejecting = definePlugin({
      name: 'test:rejecting-enricher',
      register({ container }) {
        const enricher: RequestEnricher = () => {
          throw new HttpError(400, 'TENANT_NOT_RESOLVED', 'No tenant.')
        }
        ensureMetadata(container).add('http:enrichers', enricher)
      },
    })
    const app = await bootWith(c, [
      rejecting,
      routesProvider([{ method: 'POST', url: '/login', meta: loginPost.meta! }]),
      securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 } }),
    ])
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push(await fastifyAttempt(app, c, loginPost))
    expect(statuses).toEqual([400, 400, 429, 429, 429])
  })

  it('still counts a request once in its per-route bucket (pre-hook and guard share it)', async () => {
    const c = new HttpServerCollector()
    const app = await bootWith(c, [
      routesProvider([{ method: 'POST', url: '/login', meta: loginPost.meta! }]),
      securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 } }),
    ])
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push(await fastifyAttempt(app, c, loginPost))
    expect(statuses).toEqual([200, 200, 429, 429])
  })
})

describe('a full MemoryRateLimitStore stays cheap per hit (no O(n) sweep per new client)', () => {
  it('admits new keys into a full store without rescanning every bucket', () => {
    const store = new MemoryRateLimitStore({ clock: () => 0, maxEntries: 100_000 })
    for (let i = 0; i < 100_000; i++) store.hit(`ip-${i}`, 10, 60_000)
    const started = performance.now()
    for (let i = 0; i < 2_000; i++) store.hit(`new-${i}`, 10, 60_000)
    // Rescanning 100 000 live buckets per new client took well over a second
    // here; evicting from the front of the FIFO takes a few milliseconds.
    expect(performance.now() - started).toBeLessThan(250)
    expect(store.size).toBe(100_000)
    expect(store.hit('new-1999', 1, 60_000).allowed).toBe(false)
  })
})
