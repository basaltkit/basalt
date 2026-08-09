import { describe, expect, it } from 'vitest'
import { InMemorySpanExporter } from '@basaltkit/core'
import { HttpServerCollector, tracingPlugin } from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

describe('tracingPlugin (neutral, via collector)', () => {
  it('records a server span, echoes traceparent, and exports on shutdown', async () => {
    const exporter = new InMemorySpanExporter()
    const c = new HttpServerCollector()
    const app = await bootWith(c, [tracingPlugin({ exporter, serviceName: 'test' })])

    const request = makeRequest({ method: 'POST', url: '/orders/1', routePattern: '/orders/:id' })
    const reply = new FakeReply()
    await c.runPre(request, reply)
    // a W3C traceparent is echoed back to the client
    expect(reply.headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)

    await c.runAfter(request, reply, 500, 8)
    await app.shutdown() // forceFlush → exporter receives the finished span

    expect(exporter.spans).toHaveLength(1)
    const span = exporter.spans[0]!
    expect(span.name).toBe('POST /orders/:id')
    expect(span.kind).toBe('server')
    expect(span.status).toBe('error') // 5xx
    expect(span.attributes['http.status_code']).toBe(500)
    expect(span.attributes['http.method']).toBe('POST')
  })

  it('continues an inbound traceparent (same trace id)', async () => {
    const exporter = new InMemorySpanExporter()
    const c = new HttpServerCollector()
    const app = await bootWith(c, [tracingPlugin({ exporter })])

    const traceId = 'abcdef0123456789abcdef0123456789'
    const request = makeRequest({ headers: { traceparent: `00-${traceId}-1111111111111111-01` }, routePattern: '/x' })
    const reply = new FakeReply()
    await c.runPre(request, reply)

    expect(reply.headers['traceparent']).toContain(traceId) // same trace, new span
    await c.runAfter(request, reply, 200, 3)
    await app.shutdown()

    expect(exporter.spans[0]!.context.traceId).toBe(traceId)
    expect(exporter.spans[0]!.status).toBe('ok')
  })
})
