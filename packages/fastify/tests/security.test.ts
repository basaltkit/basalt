import { describe, expect, it } from 'vitest'
import { createApp } from '@machize/core'
import {
  FASTIFY,
  fastifyPlugin,
  healthPlugin,
  MemoryRateLimitStore,
  route,
  securityPlugin,
} from '../src/index.js'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

async function boot(plugins: unknown[]) {
  const app = await createApp({ plugins: plugins as never }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

describe('securityPlugin — headers', () => {
  it('sets secure defaults on every response', async () => {
    const { app, server } = await boot([fastifyPlugin({ routes: [ping] }), securityPlugin()])
    const res = await server.inject({ method: 'GET', url: '/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['strict-transport-security']).toContain('max-age=')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    await app.shutdown()
  })

  it('respects headers: false', async () => {
    const { app, server } = await boot([fastifyPlugin({ routes: [ping] }), securityPlugin({ headers: false })])
    const res = await server.inject({ method: 'GET', url: '/ping' })
    expect(res.headers['x-frame-options']).toBeUndefined()
    await app.shutdown()
  })
})

describe('securityPlugin — CORS', () => {
  it('reflects an allow-listed origin and answers preflight', async () => {
    const { app, server } = await boot([
      fastifyPlugin({ routes: [ping] }),
      securityPlugin({ cors: { origin: ['https://app.example.com'], credentials: true }, headers: false }),
    ])

    const ok = await server.inject({
      method: 'GET',
      url: '/ping',
      headers: { origin: 'https://app.example.com' },
    })
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com')
    expect(ok.headers['access-control-allow-credentials']).toBe('true')

    const blocked = await server.inject({ method: 'GET', url: '/ping', headers: { origin: 'https://evil.com' } })
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined()

    const preflight = await server.inject({
      method: 'OPTIONS',
      url: '/ping',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
      },
    })
    expect(preflight.statusCode).toBe(204)
    expect(preflight.headers['access-control-allow-methods']).toContain('GET')
    await app.shutdown()
  })
})

describe('securityPlugin — rate limit', () => {
  it('allows up to the limit, then 429 with headers', async () => {
    let clock = 1_000_000
    const store = new MemoryRateLimitStore(() => clock)
    const { app, server } = await boot([
      fastifyPlugin({ routes: [ping] }),
      securityPlugin({ rateLimit: { limit: 2, windowMs: 60_000, store }, headers: false }),
    ])

    const first = await server.inject({ method: 'GET', url: '/ping' })
    expect(first.statusCode).toBe(200)
    expect(first.headers['x-ratelimit-remaining']).toBe('1')

    await server.inject({ method: 'GET', url: '/ping' }) // 2nd — still allowed
    const third = await server.inject({ method: 'GET', url: '/ping' })
    expect(third.statusCode).toBe(429)
    expect(JSON.parse(third.body).error.code).toBe('RATE_LIMITED')
    expect(third.headers['retry-after']).toBeDefined()

    // window rolls over
    clock += 60_001
    const afterReset = await server.inject({ method: 'GET', url: '/ping' })
    expect(afterReset.statusCode).toBe(200)
    await app.shutdown()
  })

  it('skip() bypasses limiting', async () => {
    const store = new MemoryRateLimitStore()
    const { app, server } = await boot([
      fastifyPlugin({ routes: [ping] }),
      securityPlugin({
        rateLimit: { limit: 1, windowMs: 60_000, store, skip: (req) => req.url === '/ping' },
        headers: false,
      }),
    ])
    for (let i = 0; i < 5; i++) {
      const res = await server.inject({ method: 'GET', url: '/ping' })
      expect(res.statusCode).toBe(200)
    }
    await app.shutdown()
  })
})

describe('MemoryRateLimitStore', () => {
  it('counts within a window and resets after it', () => {
    let now = 0
    const store = new MemoryRateLimitStore(() => now)
    expect(store.hit('k', 2, 100).allowed).toBe(true)
    expect(store.hit('k', 2, 100).allowed).toBe(true)
    expect(store.hit('k', 2, 100).allowed).toBe(false)
    now = 101
    expect(store.hit('k', 2, 100).allowed).toBe(true)
  })
})

describe('healthPlugin', () => {
  it('livez is always ok; readyz reflects checks', async () => {
    let dbUp = true
    const { app, server } = await boot([
      fastifyPlugin({ routes: [ping] }),
      healthPlugin({ checks: { db: () => ({ ok: dbUp, detail: dbUp ? 'connected' : 'down' }) } }),
    ])

    const live = await server.inject({ method: 'GET', url: '/livez' })
    expect(live.statusCode).toBe(200)

    const ready = await server.inject({ method: 'GET', url: '/readyz' })
    expect(ready.statusCode).toBe(200)
    expect(JSON.parse(ready.body).checks.db.ok).toBe(true)

    dbUp = false
    const unready = await server.inject({ method: 'GET', url: '/readyz' })
    expect(unready.statusCode).toBe(503)
    expect(JSON.parse(unready.body).status).toBe('unavailable')

    // liveness stays up even when a dependency is down
    expect((await server.inject({ method: 'GET', url: '/livez' })).statusCode).toBe(200)
    await app.shutdown()
  })
})
