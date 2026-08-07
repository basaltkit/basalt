import { describe, expect, it } from 'vitest'
import { MetricsRegistry } from '@machize/core'
import { HttpServerCollector, metricsPlugin } from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

describe('metricsPlugin (neutral, via collector)', () => {
  it('exposes /metrics rendering the registry as Prometheus text', async () => {
    const registry = new MetricsRegistry()
    const c = new HttpServerCollector()
    await bootWith(c, [metricsPlugin({ registry })])

    const route = c.extraRoutes.find((r) => r.url === '/metrics')
    expect(route).toMatchObject({ method: 'GET' })

    const reply = new FakeReply()
    const body = await route!.handler({ request: makeRequest(), reply })
    expect(reply.headers['content-type']).toContain('text/plain')
    expect(typeof body).toBe('string')
  })

  it('instruments requests, labelling by route template', async () => {
    const registry = new MetricsRegistry()
    const c = new HttpServerCollector()
    await bootWith(c, [metricsPlugin({ registry })])
    expect(c.preHooks).toHaveLength(1) // in-flight gauge inc
    expect(c.afterHooks).toHaveLength(1)

    const request = makeRequest({ method: 'POST', url: '/users/42', routePattern: '/users/:id' })
    await c.runPre(request, new FakeReply())
    await c.runAfter(request, new FakeReply(), 201, 15)

    const output = registry.render()
    expect(output).toContain('http_requests_total')
    expect(output).toContain('route="/users/:id"')
    expect(output).toContain('status="201"')
    expect(output).toContain('http_request_duration_seconds')
  })

  it('can be created without HTTP instrumentation', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [metricsPlugin({ instrumentHttp: false })])
    expect(c.preHooks).toHaveLength(0)
    expect(c.afterHooks).toHaveLength(0)
    expect(c.extraRoutes.some((r) => r.url === '/metrics')).toBe(true) // route still exposed
  })

  it('honors a custom path', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [metricsPlugin({ path: '/internal/metrics' })])
    expect(c.extraRoutes.some((r) => r.url === '/internal/metrics')).toBe(true)
  })
})
