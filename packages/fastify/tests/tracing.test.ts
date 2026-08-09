import { describe, expect, it } from 'vitest'
import { createApp, formatTraceparent, InMemorySpanExporter } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route, tracingPlugin } from '../src/index.js'

const routes = [
  route({ method: 'GET', url: '/users/:id', async handler() { return { id: 1 } } }),
  route({ method: 'GET', url: '/boom', async handler({ reply }) { return reply.code(500).send({ e: 1 }) } }),
]

describe('tracingPlugin', () => {
  it('records a server span per request, labelled by route template', async () => {
    const exporter = new InMemorySpanExporter()
    const app = await createApp({ plugins: [fastifyPlugin({ routes }), tracingPlugin({ exporter })] }).boot()
    const server = app.container.get(FASTIFY)

    const res = await server.inject({ method: 'GET', url: '/users/42' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)

    expect(exporter.spans).toHaveLength(1)
    const span = exporter.spans[0]!
    expect(span.name).toBe('GET /users/:id') // template, not /users/42
    expect(span.kind).toBe('server')
    expect(span.attributes['http.status_code']).toBe(200)
    expect(span.status).toBe('ok')
    await app.shutdown()
  })

  it('continues an inbound trace and marks 5xx as error', async () => {
    const exporter = new InMemorySpanExporter()
    const app = await createApp({ plugins: [fastifyPlugin({ routes }), tracingPlugin({ exporter })] }).boot()
    const server = app.container.get(FASTIFY)

    const traceId = 'a'.repeat(32)
    const parentSpanId = 'b'.repeat(16)
    await server.inject({
      method: 'GET',
      url: '/boom',
      headers: { traceparent: formatTraceparent({ traceId, spanId: parentSpanId, traceFlags: 1 }) },
    })

    const span = exporter.spans[0]!
    expect(span.context.traceId).toBe(traceId) // trace continued
    expect(span.parentSpanId).toBe(parentSpanId)
    expect(span.status).toBe('error')
    await app.shutdown()
  })
})
