import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { healthPlugin, MemoryRateLimitStore, metricsPlugin, route, securityPlugin } from '@basaltkit/http'
import { HONO, honoPlugin } from '../src/index.js'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

let app: BasaltApp
let call: (path: string) => Promise<Response>

async function boot(...plugins: unknown[]) {
  app = await createApp({ plugins: [honoPlugin({ routes: [ping] }), ...plugins] as never }).boot()
  const hono = app.container.get(HONO)
  call = (path) => Promise.resolve(hono.fetch(new Request(`http://local${path}`)))
}

afterEach(async () => {
  await app.shutdown()
})

describe('edge plugins on Hono', () => {
  it('security headers + health + metrics all work through the neutral adapter', async () => {
    await boot(
      securityPlugin({ headers: true }),
      healthPlugin({ checks: { db: () => ({ ok: true }) } }),
      metricsPlugin(),
    )

    const ping1 = await call('/ping')
    expect(ping1.status).toBe(200)
    expect(ping1.headers.get('x-frame-options')).toBe('DENY')

    expect((await call('/livez')).status).toBe(200)
    expect((await call('/readyz')).status).toBe(200)

    const metrics = await call('/metrics')
    expect(metrics.status).toBe(200)
    const body = await metrics.text()
    expect(body).toContain('http_requests_total')
    expect(body).toContain('route="/ping"')
  })

  it('rate limiting returns 429 after the limit', async () => {
    const store = new MemoryRateLimitStore()
    await boot(securityPlugin({ rateLimit: { limit: 2, windowMs: 60_000, store }, headers: false }))
    expect((await call('/ping')).status).toBe(200)
    expect((await call('/ping')).status).toBe(200)
    const blocked = await call('/ping')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
  })
})
