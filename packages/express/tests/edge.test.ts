import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type MachizeApp } from '@machize/core'
import { healthPlugin, MemoryRateLimitStore, metricsPlugin, route, securityPlugin } from '@machize/http'
import { EXPRESS, expressPlugin } from '../src/index.js'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

let app: MachizeApp
let base: string
let server: Server

async function boot(...plugins: unknown[]) {
  app = await createApp({ plugins: [expressPlugin({ routes: [ping] }), ...plugins] as never }).boot()
  server = app.container.get(EXPRESS).listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await app.shutdown()
})

describe('edge plugins on Express', () => {
  it('security headers + health + metrics all work through the neutral adapter', async () => {
    await boot(
      securityPlugin({ headers: true }),
      healthPlugin({ checks: { db: () => ({ ok: true }) } }),
      metricsPlugin(),
    )

    const ping1 = await fetch(`${base}/ping`)
    expect(ping1.status).toBe(200)
    expect(ping1.headers.get('x-frame-options')).toBe('DENY') // securityPlugin

    expect((await fetch(`${base}/livez`)).status).toBe(200) // healthPlugin
    const ready = await fetch(`${base}/readyz`)
    expect(ready.status).toBe(200)

    const metrics = await fetch(`${base}/metrics`) // metricsPlugin
    expect(metrics.status).toBe(200)
    const body = await metrics.text()
    expect(body).toContain('http_requests_total')
    expect(body).toContain('route="/ping"')
  })

  it('rate limiting returns 429 after the limit', async () => {
    const store = new MemoryRateLimitStore()
    await boot(securityPlugin({ rateLimit: { limit: 2, windowMs: 60_000, store }, headers: false }))
    expect((await fetch(`${base}/ping`)).status).toBe(200)
    expect((await fetch(`${base}/ping`)).status).toBe(200)
    const blocked = await fetch(`${base}/ping`)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
  })
})
