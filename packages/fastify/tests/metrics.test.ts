import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, METRICS, metricsPlugin, route } from '../src/index.js'

const routes = [
  route({ method: 'GET', url: '/ok', async handler() { return { ok: true } } }),
  route({ method: 'GET', url: '/users/:id', async handler() { return { id: 1 } } }),
]

describe('metricsPlugin', () => {
  it('serves /metrics and auto-instruments requests by route template', async () => {
    const app = await createApp({ plugins: [fastifyPlugin({ routes }), metricsPlugin()] }).boot()
    const server = app.container.get(FASTIFY)

    await server.inject({ method: 'GET', url: '/ok' })
    await server.inject({ method: 'GET', url: '/users/1' })
    await server.inject({ method: 'GET', url: '/users/2' })

    const res = await server.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    const body = res.body
    expect(body).toContain('http_requests_total')
    // route labelled by template — /users/1 and /users/2 collapse to /users/:id
    expect(body).toContain('route="/users/:id"')
    expect(body).not.toContain('route="/users/1"')
    expect(body).toContain('http_request_duration_seconds_bucket')
    await app.shutdown()
  })

  it('exposes the registry via the METRICS token for app metrics', async () => {
    const app = await createApp({ plugins: [fastifyPlugin({ routes }), metricsPlugin()] }).boot()
    const registry = app.container.get(METRICS)
    registry.counter('jobs_processed_total').inc()
    const server = app.container.get(FASTIFY)
    const res = await server.inject({ method: 'GET', url: '/metrics' })
    expect(res.body).toContain('jobs_processed_total 1')
    await app.shutdown()
  })
})
