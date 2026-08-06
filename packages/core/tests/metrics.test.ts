import { describe, expect, it } from 'vitest'
import { MetricsRegistry } from '../src/index.js'

describe('MetricsRegistry', () => {
  it('counters accumulate per label set and render Prometheus text', () => {
    const registry = new MetricsRegistry()
    const c = registry.counter('http_requests_total', { help: 'Total', labelNames: ['method'] })
    c.inc({ method: 'GET' })
    c.inc({ method: 'GET' })
    c.inc({ method: 'POST' })
    const out = registry.render()
    expect(out).toContain('# TYPE http_requests_total counter')
    expect(out).toContain('http_requests_total{method="GET"} 2')
    expect(out).toContain('http_requests_total{method="POST"} 1')
  })

  it('counters reject negative increments', () => {
    const c = new MetricsRegistry().counter('x')
    expect(() => c.inc({}, -1)).toThrow()
  })

  it('gauges set/inc/dec', () => {
    const g = new MetricsRegistry().gauge('in_flight')
    g.inc()
    g.inc()
    g.dec()
    expect(g.render()).toContain('in_flight 1')
    g.set(42)
    expect(g.render()).toContain('in_flight 42')
  })

  it('histograms emit cumulative buckets, sum and count', () => {
    const h = new MetricsRegistry().histogram('dur', { buckets: [0.1, 0.5, 1] })
    h.observe(0.05)
    h.observe(0.2)
    h.observe(2)
    const out = h.render()
    expect(out).toContain('# TYPE dur histogram')
    expect(out).toContain('dur_bucket{le="0.1"} 1') // only 0.05
    expect(out).toContain('dur_bucket{le="0.5"} 2') // 0.05, 0.2
    expect(out).toContain('dur_bucket{le="+Inf"} 3')
    expect(out).toContain('dur_sum 2.25')
    expect(out).toContain('dur_count 3')
  })

  it('escapes label values', () => {
    const c = new MetricsRegistry().counter('e', { labelNames: ['path'] })
    c.inc({ path: 'a"b' })
    expect(c.render()).toContain('path="a\\"b"')
  })

  it('returns the same metric instance for the same name', () => {
    const r = new MetricsRegistry()
    expect(r.counter('same')).toBe(r.counter('same'))
  })
})
