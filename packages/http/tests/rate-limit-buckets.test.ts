import { definePlugin, ensureMetadata } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import {
  HttpServerCollector,
  InvalidRouteMetaError,
  MemoryRateLimitStore,
  assertRouteMetaValid,
  route,
  runRoute,
  securityPlugin,
  toErrorResponse,
  type BasaltRoute,
  type PrefixRateLimit,
  type RateLimitOptions,
  type RateLimitResult,
  type RateLimitStore,
  type RequestEnricher,
  type RouteGuard,
  type RouteRateLimits,
} from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

/**
 * BK-083 (g): per-API-key budgets, several budgets per route, shared buckets
 * and path-prefix edge budgets.
 */

/** Sets ctx().user / ctx().tenant / ctx().apiKey from headers, like auth, tenancy and apiKeysPlugin do. */
const identity = definePlugin({
  name: 'test:identity',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const scope = context as unknown as Record<string, unknown>
      const { 'x-user': user, 'x-tenant': tenant, 'x-key': key } = request.headers
      if (typeof user === 'string') scope['user'] = { id: user }
      if (typeof tenant === 'string') scope['tenant'] = { id: tenant }
      if (typeof key === 'string') scope['apiKey'] = { id: key, scopes: ['*'] }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

const publish = (routes: BasaltRoute[]) =>
  definePlugin({
    name: 'test:routes',
    boot({ container }) {
      for (const r of routes) ensureMetadata(container).add('http:routes', { method: r.method, url: r.url, meta: r.meta ?? {} })
    },
  })

/** A store that records every key it was charged on. */
class SpyStore implements RateLimitStore {
  readonly hits: string[] = []
  readonly inner: MemoryRateLimitStore
  constructor(clock: () => number = () => 1_000_000) {
    this.inner = new MemoryRateLimitStore(clock)
  }
  hit(key: string, limit: number, windowMs: number): RateLimitResult {
    this.hits.push(key)
    return this.inner.hit(key, limit, windowMs)
  }
  reset(key: string): void {
    this.inner.reset(key)
  }
}

interface Call {
  method?: string
  url?: string
  ip?: string
  user?: string
  tenant?: string
  key?: string
}

interface Outcome {
  status: number
  headers: Record<string, string>
}

async function setup(
  routes: BasaltRoute[],
  options: { routed?: boolean; rateLimit?: Partial<RateLimitOptions>; store?: SpyStore } = {},
) {
  const store = options.store ?? new SpyStore()
  const c = new HttpServerCollector()
  const app = await bootWith(c, [
    identity,
    publish(routes),
    securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000, store, ...options.rateLimit }, headers: false }),
  ])
  const send = async (call: Call = {}): Promise<Outcome> => {
    const method = call.method ?? routes[0]!.method
    const url = call.url ?? routes[0]!.url
    const definition = routes.find((r) => r.method === method && r.url === url.split('?')[0])
    const headers: Record<string, string> = {}
    if (call.user) headers['x-user'] = call.user
    if (call.tenant) headers['x-tenant'] = call.tenant
    if (call.key) headers['x-key'] = call.key
    const request = makeRequest({
      method,
      url,
      ip: call.ip ?? '203.0.113.10',
      headers,
      raw: {},
      ...(options.routed && definition ? { routePattern: definition.url } : {}),
    })
    const reply = new FakeReply()
    if (await c.runPre(request, reply)) return { status: reply.statusCode, headers: reply.headers }
    if (!definition) return { status: 404, headers: reply.headers }
    try {
      await runRoute(definition, request, reply, {
        container: app.container,
        enrichers: ensureMetadata(app.container).get<RequestEnricher>('http:enrichers'),
        guards: ensureMetadata(app.container).get<RouteGuard>('http:guards'),
      })
      return { status: reply.statusCode, headers: reply.headers }
    } catch (error) {
      return { status: toErrorResponse(error).status, headers: reply.headers }
    }
  }
  const status = async (call: Call = {}): Promise<number> => (await send(call)).status
  return { send, status, store, app }
}

const ok = () => ({ ok: true })
const limited = (rateLimit: unknown, method = 'GET', url = '/x') =>
  route({ method: method as 'GET', url, meta: { rateLimit }, handler: ok })

describe("meta.rateLimit key 'apiKey'", () => {
  it('two keys behind one IP get separate budgets', async () => {
    const { status } = await setup([limited({ limit: 1, windowMs: 60_000, key: 'apiKey' })])
    expect(await status({ key: 'k1' })).toBe(200)
    expect(await status({ key: 'k1' })).toBe(429)
    expect(await status({ key: 'k2' })).toBe(200)
  })

  it('falls back to the IP when no key was verified', async () => {
    const { status } = await setup([limited({ limit: 1, windowMs: 60_000, key: 'apiKey' })])
    expect(await status({ ip: '198.51.100.1' })).toBe(200)
    expect(await status({ ip: '198.51.100.1' })).toBe(429)
    expect(await status({ ip: '198.51.100.2' })).toBe(200)
  })

  it('apikey:<id> never collides with user:<id>', async () => {
    const { status, store } = await setup([limited({ limit: 1, windowMs: 60_000, key: 'apiKey' })])
    expect(await status({ key: 'same' })).toBe(200)
    const other = await setup([limited({ limit: 1, windowMs: 60_000, key: 'user' })], { store })
    expect(await other.status({ user: 'same' })).toBe(200)
    expect(store.hits.filter((k) => k.endsWith('::/x'))).toEqual(['apikey:same::/x', 'user:same::/x'])
  })

  it('the legacy single object honours it too (it used to fall back to the IP)', async () => {
    const { status, store } = await setup([limited({ limit: 1, windowMs: 60_000, key: 'apiKey' })], { routed: true })
    expect(await status({ key: 'k1' })).toBe(200)
    expect(store.hits).toContain('apikey:k1::/x')
  })
})

describe('meta.rateLimit as an array (several budgets on one route)', () => {
  const burstAndQuota = [
    { limit: 2, windowMs: 1_000, key: 'apiKey' },
    { limit: 3, windowMs: 86_400_000, key: 'tenant' },
  ] satisfies RouteRateLimits

  it('enforces both the burst and the quota', async () => {
    let now = 1_000_000
    const store = new SpyStore(() => now)
    const { status } = await setup([limited(burstAndQuota)], { store })
    expect(await status({ key: 'k1', tenant: 't1' })).toBe(200)
    expect(await status({ key: 'k1', tenant: 't1' })).toBe(200)
    expect(await status({ key: 'k1', tenant: 't1' })).toBe(429) // burst
    now += 1_000
    expect(await status({ key: 'k1', tenant: 't1' })).toBe(200)
    now += 1_000
    expect(await status({ key: 'k1', tenant: 't1' })).toBe(429) // daily quota
    expect(await status({ key: 'k2', tenant: 't1' })).toBe(429) // quota is per tenant
    expect(await status({ key: 'k3', tenant: 't2' })).toBe(200)
  })

  it('stops at the first refusal: the quota is not charged for a burst refusal', async () => {
    const { status, store } = await setup([limited(burstAndQuota)])
    for (let i = 0; i < 3; i++) await status({ key: 'k1', tenant: 't1' })
    const quotaHits = store.hits.filter((k) => k.includes('#1|'))
    expect(quotaHits).toHaveLength(2)
  })

  it('keys entries by method, url and position', async () => {
    const { status, store } = await setup([limited(burstAndQuota)])
    await status({ key: 'k1', tenant: 't1' })
    expect(store.hits.slice(-2)).toEqual(['rl|route:GET /x#0|apikey:k1', 'rl|route:GET /x#1|tenant:t1'])
  })

  it('a changed budget keeps the running counter (limit/window are not in the key)', async () => {
    const store = new SpyStore()
    const first = await setup([limited([{ limit: 2, windowMs: 60_000 }])], { store })
    expect(await first.status()).toBe(200)
    expect(await first.status()).toBe(200)
    const raised = await setup([limited([{ limit: 3, windowMs: 60_000 }])], { store })
    expect(await raised.status()).toBe(200)
    expect(await raised.status()).toBe(429)
  })

  it('GET and POST on one URL have separate counters', async () => {
    const { status } = await setup([
      limited([{ limit: 1, windowMs: 60_000 }], 'GET'),
      limited([{ limit: 1, windowMs: 60_000 }], 'POST'),
    ])
    expect(await status({ method: 'GET' })).toBe(200)
    expect(await status({ method: 'POST' })).toBe(200)
    expect(await status({ method: 'GET' })).toBe(429)
  })

  it('reports the most constraining bucket, and Retry-After from the refusing one', async () => {
    const { send } = await setup([
      limited([
        { limit: 10, windowMs: 1_000 },
        { limit: 2, windowMs: 60_000 },
      ]),
    ])
    const first = await send()
    expect(first.headers['x-ratelimit-limit']).toBe('2')
    expect(first.headers['x-ratelimit-remaining']).toBe('1')
    await send()
    const refused = await send()
    expect(refused.status).toBe(429)
    expect(refused.headers['x-ratelimit-limit']).toBe('2')
    expect(refused.headers['retry-after']).toBe('60')
  })

  it('breaks a remaining tie by the later reset', async () => {
    const { send } = await setup([
      limited([
        { limit: 5, windowMs: 1_000 },
        { limit: 5, windowMs: 60_000 },
      ]),
    ])
    const res = await send()
    expect(res.headers['x-ratelimit-reset']).toBe(String(Math.ceil((1_000_000 + 60_000) / 1000)))
  })

  it('charges the new forms in the guard even on Fastify (on top of the global bucket)', async () => {
    const { status, store } = await setup([limited([{ limit: 5, windowMs: 60_000 }])], { routed: true })
    expect(await status()).toBe(200)
    expect(store.hits).toEqual(['203.0.113.10', 'rl|route:GET /x#0|203.0.113.10'])
  })
})

describe('meta.rateLimit shared buckets', () => {
  it('two routes declaring one bucket share a counter', async () => {
    const daily = { limit: 2, windowMs: 86_400_000, key: 'tenant', bucket: 'public-api-daily' } as const
    const { status, store } = await setup([limited(daily, 'GET', '/a'), limited([daily], 'POST', '/b')])
    expect(await status({ url: '/a', tenant: 't1' })).toBe(200)
    expect(await status({ method: 'POST', url: '/b', tenant: 't1' })).toBe(200)
    expect(await status({ url: '/a', tenant: 't1' })).toBe(429)
    expect(store.hits.filter((k) => k.startsWith('rl|'))).toEqual([
      'rl|bucket:public-api-daily|tenant:t1',
      'rl|bucket:public-api-daily|tenant:t1',
      'rl|bucket:public-api-daily|tenant:t1',
    ])
  })
})

describe('meta.rateLimit boot validation', () => {
  const problemsOf = async (rateLimit: unknown): Promise<string[]> => {
    const { app } = await setup([limited({ limit: 1, windowMs: 1 })])
    try {
      assertRouteMetaValid([limited(rateLimit)], app.container)
      return []
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRouteMetaError)
      return (error as InvalidRouteMetaError).problems.map((p) => p.problem)
    }
  }

  it('refuses malformed new forms', async () => {
    expect(await problemsOf([])).toEqual(['meta.rateLimit must not be an empty array'])
    expect(await problemsOf([5])).toEqual(['meta.rateLimit[0] must be an object { limit, windowMs, key?, bucket? }'])
    expect(await problemsOf([{ limit: 0, windowMs: Infinity }])).toEqual([
      'meta.rateLimit[0].limit must be a finite number above 0 (got 0)',
      'meta.rateLimit[0].windowMs must be a finite number above 0 (got Infinity)',
    ])
    expect((await problemsOf([{ limit: 1, windowMs: 1, key: 'session' }]))[0]).toMatch(/key "session" is not one of/)
    expect((await problemsOf({ limit: 1, windowMs: 1, bucket: 'has space' }))[0]).toMatch(/bucket "has space" must match/)
    expect((await problemsOf({ limit: 1, windowMs: 1, bucket: 'x'.repeat(65) }))[0]).toMatch(/must match/)
  })

  it('accepts well-formed new forms and keeps the legacy object lenient', async () => {
    expect(await problemsOf([{ limit: 1, windowMs: 1, key: 'apiKey', bucket: 'a.b:c-d_e' }])).toEqual([])
    expect(await problemsOf({ limit: -1, windowMs: 'soon', key: 'nonsense' })).toEqual([])
  })

  it('refuses a shared bucket declared with a different limit, window or key', async () => {
    const boot = setup([
      limited({ limit: 5, windowMs: 60_000, key: 'tenant', bucket: 'b' }, 'GET', '/a'),
      limited([{ limit: 6, windowMs: 1_000, key: 'user', bucket: 'b' }], 'POST', '/b'),
    ])
    await expect(boot).rejects.toBeInstanceOf(InvalidRouteMetaError)
    await boot.catch((error: InvalidRouteMetaError) => {
      expect(error.problems).toEqual([
        {
          route: 'POST /b',
          problem: "meta.rateLimit bucket 'b' disagrees with its first declaration (GET /a): limit 6 vs 5, windowMs 1000 vs 60000, key 'user' vs 'tenant'",
        },
      ])
    })
  })

  it('never compares function keys', async () => {
    const { status } = await setup([
      limited({ limit: 1, windowMs: 60_000, key: (c: Record<string, unknown>) => (c['tenant'] as { id: string } | undefined)?.id, bucket: 'f' }, 'GET', '/a'),
      limited({ limit: 1, windowMs: 60_000, key: (c: Record<string, unknown>) => (c['tenant'] as { id: string } | undefined)?.id, bucket: 'f' }, 'GET', '/b'),
    ])
    expect(await status({ url: '/a', tenant: 't1' })).toBe(200)
    expect(await status({ url: '/b', tenant: 't1' })).toBe(429)
  })
})

describe('rateLimit.prefixes (path-prefix edge budgets)', () => {
  const routes = [
    route({ method: 'GET', url: '/v1/orders', handler: ok }),
    route({ method: 'GET', url: '/v10/orders', handler: ok }),
    route({ method: 'GET', url: '/v1/admin/x', handler: ok }),
    route({ method: 'GET', url: '/app', handler: ok }),
  ]
  const config = (extra: Partial<RateLimitOptions> = {}) => ({
    rateLimit: { limit: 2, windowMs: 60_000, prefixes: [{ prefix: '/v1', limit: 4, windowMs: 60_000 }], ...extra },
  })

  it('replaces the global bucket, with a ceiling above the global one', async () => {
    const { status, store } = await setup(routes, config())
    for (let i = 0; i < 4; i++) expect(await status({ url: '/v1/orders' })).toBe(200)
    expect(await status({ url: '/v1/orders' })).toBe(429)
    // The rest of the app keeps the global budget, untouched by /v1 traffic.
    expect(await status({ url: '/app' })).toBe(200)
    expect(await status({ url: '/app' })).toBe(200)
    expect(await status({ url: '/app' })).toBe(429)
    expect(store.hits[0]).toBe('prefix:/v1::203.0.113.10')
  })

  it('the longest prefix wins; /v10 does not match /v1', async () => {
    const { status, store } = await setup(routes, {
      rateLimit: {
        limit: 2,
        windowMs: 60_000,
        prefixes: [
          { prefix: '/v1', limit: 4, windowMs: 60_000 },
          { prefix: '/v1/admin/', limit: 1, windowMs: 60_000 },
        ],
      },
    })
    expect(await status({ url: '/v1/admin/x' })).toBe(200)
    expect(await status({ url: '/v1/admin/x' })).toBe(429)
    expect(await status({ url: '/v10/orders' })).toBe(200)
    expect(store.hits).toEqual(['prefix:/v1/admin::203.0.113.10', 'prefix:/v1/admin::203.0.113.10', '203.0.113.10'])
  })

  it('normalises case, repeated slashes, a trailing slash and the query string (no decoding)', async () => {
    const { status, store } = await setup(routes, config())
    await status({ url: '/V1//orders/?a=b' })
    await status({ url: '/v1?x' })
    await status({ url: '/%2Fv1/orders' })
    expect(store.hits).toEqual(['prefix:/v1::203.0.113.10', 'prefix:/v1::203.0.113.10', '203.0.113.10'])
  })

  it('counts 404s under the prefix', async () => {
    const { status } = await setup(routes, config())
    for (let i = 0; i < 4; i++) expect(await status({ url: '/v1/missing' })).toBe(404)
    expect(await status({ url: '/v1/orders' })).toBe(429)
  })

  it('uses its own key, else the global key', async () => {
    const own = await setup(routes, {
      rateLimit: { limit: 2, windowMs: 60_000, prefixes: [{ prefix: '/v1', limit: 4, windowMs: 60_000, key: () => 'edge' }] },
    })
    await own.status({ url: '/v1/orders' })
    expect(own.store.hits).toEqual(['prefix:/v1::edge'])
    const global = await setup(routes, config({ key: () => 'proxy-ip' }))
    await global.status({ url: '/v1/orders' })
    expect(global.store.hits).toEqual(['prefix:/v1::proxy-ip'])
  })

  it('skip skips the prefix buckets too', async () => {
    const { status, store } = await setup(routes, config({ skip: () => true }))
    for (let i = 0; i < 6; i++) expect(await status({ url: '/v1/orders' })).toBe(200)
    expect(store.hits).toEqual([])
  })

  it('refuses a bad configuration at construction', () => {
    const make = (prefixes: unknown) =>
      securityPlugin({ rateLimit: { limit: 1, windowMs: 1, prefixes: prefixes as readonly PrefixRateLimit[] } })
    expect(() => make([{ prefix: 'v1', limit: 1, windowMs: 1 }])).toThrow(TypeError)
    expect(() => make([{ prefix: '/v1?x', limit: 1, windowMs: 1 }])).toThrow(/must not contain/)
    expect(() => make([{ prefix: '/v1', limit: 0, windowMs: 1 }])).toThrow(/above 0/)
    expect(() => make([{ prefix: '/v1', limit: 1, windowMs: Number.NaN }])).toThrow(/above 0/)
    expect(() => make([{ prefix: '/v1', limit: 1, windowMs: 1, key: 'ip' }])).toThrow(/key must be a function/)
    expect(() => make([{ prefix: '/V1/', limit: 1, windowMs: 1 }, { prefix: '/v1', limit: 1, windowMs: 1 }])).toThrow(/duplicates/)
    expect(() => make('/v1')).toThrow(/must be an array/)
    // Without a rate limit the prefixes are never read.
    expect(() => securityPlugin({ rateLimit: false })).not.toThrow()
  })

  it('a prefix of / covers every path', async () => {
    const { status, store } = await setup(routes, { rateLimit: { limit: 1, windowMs: 60_000, prefixes: [{ prefix: '/', limit: 3, windowMs: 60_000 }] } })
    expect(await status({ url: '/app' })).toBe(200)
    expect(await status({ url: '/app' })).toBe(200)
    expect(store.hits).toEqual(['prefix:/::203.0.113.10', 'prefix:/::203.0.113.10'])
  })

  it('on Fastify, a legacy IP route override still replaces the edge bucket', async () => {
    const legacy = route({ method: 'GET', url: '/v1/login', meta: { rateLimit: { limit: 1, windowMs: 60_000 } }, handler: ok })
    const { status, store } = await setup([legacy], { ...config(), routed: true })
    expect(await status({ url: '/v1/login' })).toBe(200)
    expect(await status({ url: '/v1/login' })).toBe(429)
    expect(store.hits).toEqual(['203.0.113.10::/v1/login', '203.0.113.10::/v1/login'])
  })
})

describe('legacy meta.rateLimit regression', () => {
  it('Fastify fast path: charged once, historical key', async () => {
    const { status, store } = await setup([limited({ limit: 2, windowMs: 60_000 })], { routed: true })
    expect(await status()).toBe(200)
    expect(store.hits).toEqual(['203.0.113.10::/x'])
  })

  it('guard path: global bucket plus the historical route key', async () => {
    const { status, store } = await setup([limited({ limit: 2, windowMs: 60_000, key: 'user' })])
    expect(await status({ user: 'u1' })).toBe(200)
    expect(store.hits).toEqual(['203.0.113.10', 'user:u1::/x'])
  })
})
