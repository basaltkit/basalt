import { describe, expect, it, vi } from 'vitest'
import {
  formatTraceparent,
  InMemorySpanExporter,
  OtlpHttpExporter,
  parseTraceparent,
  toOtlpJson,
  Tracer,
  type FinishedSpan,
} from '../src/index.js'

describe('W3C traceparent', () => {
  it('round-trips and rejects malformed headers', () => {
    const ctx = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }
    expect(formatTraceparent(ctx)).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`)
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx)
    expect(parseTraceparent('garbage')).toBeNull()
    expect(parseTraceparent(undefined)).toBeNull()
  })
})

describe('Tracer', () => {
  it('exports finished spans with duration and status', async () => {
    const exporter = new InMemorySpanExporter()
    let now = 1000
    const tracer = new Tracer({ exporter, clock: () => now })

    const span = tracer.startSpan('GET /users', { kind: 'server', attributes: { 'http.method': 'GET' } })
    now = 1050
    span.setAttribute('http.status_code', 200).setStatus('ok').end()

    expect(exporter.spans).toHaveLength(1)
    const [finished] = exporter.spans
    expect(finished!.name).toBe('GET /users')
    expect(finished!.endTime - finished!.startTime).toBe(50)
    expect(finished!.attributes['http.status_code']).toBe(200)
    expect(finished!.status).toBe('ok')
  })

  it('child spans inherit the trace id and link to the parent', async () => {
    const exporter = new InMemorySpanExporter()
    const tracer = new Tracer({ exporter })
    const parent = tracer.startSpan('parent', { kind: 'server' })
    await tracer.inSpan(parent, async () => {
      const child = tracer.startSpan('child')
      child.end()
    })
    const child = exporter.spans.find((s) => s.name === 'child')!
    expect(child.context.traceId).toBe(parent.context.traceId)
    expect(child.parentSpanId).toBe(parent.context.spanId)
  })

  it('continues an inbound trace from a parent context', () => {
    const exporter = new InMemorySpanExporter()
    const tracer = new Tracer({ exporter })
    const inbound = parseTraceparent(`00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`)!
    const span = tracer.startSpan('server', { parent: inbound, kind: 'server' })
    span.end()
    expect(span.context.traceId).toBe('c'.repeat(32))
    expect(span.parentSpanId).toBe('d'.repeat(16))
  })

  it('inSpan records errors and re-throws', async () => {
    const exporter = new InMemorySpanExporter()
    const tracer = new Tracer({ exporter })
    await expect(
      tracer.inSpan(tracer.startSpan('boom'), async () => {
        throw new Error('kaboom')
      }),
    ).rejects.toThrow('kaboom')
    expect(exporter.spans[0]!.status).toBe('error')
    expect(exporter.spans[0]!.statusMessage).toContain('kaboom')
  })
})

describe('OTLP export', () => {
  const span: FinishedSpan = {
    name: 'op',
    kind: 'server',
    context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 },
    parentSpanId: 'c'.repeat(16),
    startTime: 1000,
    endTime: 1005,
    attributes: { 'http.method': 'GET', count: 3, ok: true },
    status: 'ok',
  }

  it('serializes to the OTLP/JSON shape', () => {
    const doc = toOtlpJson([span], 'my-svc') as any
    const otlp = doc.resourceSpans[0]
    expect(otlp.resource.attributes[0]).toEqual({ key: 'service.name', value: { stringValue: 'my-svc' } })
    const s = otlp.scopeSpans[0].spans[0]
    expect(s.traceId).toBe('a'.repeat(32))
    expect(s.kind).toBe(2) // server
    expect(s.startTimeUnixNano).toBe('1000000000') // ms → ns
    expect(s.status.code).toBe(1)
    expect(s.attributes).toContainEqual({ key: 'count', value: { intValue: '3' } })
  })

  it('OtlpHttpExporter POSTs to /v1/traces on flush', async () => {
    const fetchImpl = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 })),
    )
    const exporter = new OtlpHttpExporter({
      url: 'http://collector:4318/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      serviceName: 'svc',
    })
    exporter.export([span])
    await exporter.forceFlush()
    expect(fetchImpl).toHaveBeenCalledOnce()
    const url = fetchImpl.mock.calls[0]![0]
    const init = fetchImpl.mock.calls[0]![1]!
    expect(url).toBe('http://collector:4318/v1/traces')
    expect(JSON.parse(init.body as string).resourceSpans).toBeDefined()
  })
})
