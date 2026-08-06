import {
  createToken,
  definePlugin,
  formatTraceparent,
  parseTraceparent,
  Tracer,
  type Span,
  type SpanExporter,
} from '@machize/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { FASTIFY } from './adapter.js'

export const TRACER = createToken<Tracer>('tracer')

const SPAN = Symbol('machize.span')

export interface TracingPluginOptions {
  serviceName?: string
  /** Where finished spans go (e.g. OtlpHttpExporter). */
  exporter?: SpanExporter
  /** Bring your own tracer (overrides serviceName/exporter). */
  tracer?: Tracer
  /** Flush interval in ms for buffered exporters. Default 5000. */
  flushIntervalMs?: number
}

/**
 * Distributed tracing at the HTTP edge: continues an inbound W3C `traceparent`
 * (or starts a new trace), records a server span per request with HTTP
 * attributes and status, echoes `traceparent` on the response, and exports
 * finished spans. Resolve `TRACER` to add spans around your own work.
 */
export function tracingPlugin(options: TracingPluginOptions = {}) {
  const tracer =
    options.tracer ??
    new Tracer({
      ...(options.exporter ? { exporter: options.exporter } : {}),
      ...(options.serviceName ? { serviceName: options.serviceName } : {}),
    })
  let timer: ReturnType<typeof setInterval> | undefined

  return definePlugin({
    name: 'machize:tracing',
    dependsOn: ['machize:fastify'],
    register({ container }) {
      container.singleton(TRACER, () => tracer)
    },
    boot({ container }) {
      const app: FastifyInstance = container.get(FASTIFY)

      app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        const traceparent = request.headers['traceparent']
        const parent = parseTraceparent(Array.isArray(traceparent) ? traceparent[0] : traceparent)
        const span = tracer.startSpan(`${request.method} ${request.routeOptions?.url ?? request.url}`, {
          kind: 'server',
          ...(parent ? { parent } : {}),
          attributes: { 'http.method': request.method, 'http.target': request.url },
        })
        ;(request as unknown as Record<symbol, Span>)[SPAN] = span
        void reply.header('traceparent', formatTraceparent(span.context))
      })

      app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
        const span = (request as unknown as Record<symbol, Span>)[SPAN]
        if (!span) return
        span.setAttribute('http.status_code', reply.statusCode)
        span.setStatus(reply.statusCode >= 500 ? 'error' : 'ok')
        span.end()
      })

      timer = setInterval(() => void tracer.forceFlush(), options.flushIntervalMs ?? 5000)
      timer.unref()
    },
    async shutdown() {
      if (timer) clearInterval(timer)
      await tracer.forceFlush()
    },
  })
}
