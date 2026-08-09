import { createToken, definePlugin, formatTraceparent, parseTraceparent, Tracer, type Span, type SpanExporter } from '@basaltkit/core'
import type { HttpRequest } from './route.js'
import { HTTP_SERVER } from './server.js'

export const TRACER = createToken<Tracer>('tracer')

const SPAN = Symbol('basalt.span')

export interface TracingPluginOptions {
  serviceName?: string
  exporter?: SpanExporter
  tracer?: Tracer
  flushIntervalMs?: number
}

const headerOf = (request: HttpRequest, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Distributed tracing as a neutral pre/after hook: continues an inbound W3C
 * `traceparent`, records a server span per request, echoes `traceparent`, and
 * exports. Runs on Fastify, Express and Hono.
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
    name: 'basalt:tracing',
    register({ container }) {
      container.singleton(TRACER, () => tracer)
    },
    boot({ container }) {
      const server = container.get(HTTP_SERVER)

      server.use(({ request, reply }) => {
        const parent = parseTraceparent(headerOf(request, 'traceparent'))
        const span = tracer.startSpan(`${request.method} ${request.routePattern ?? request.url}`, {
          kind: 'server',
          ...(parent ? { parent } : {}),
          attributes: { 'http.method': request.method, 'http.target': request.url },
        })
        // Stash on the native request (`raw`), stable across the pre/after hooks.
        ;(request.raw as Record<symbol, Span>)[SPAN] = span
        reply.header('traceparent', formatTraceparent(span.context))
      })

      server.after(({ request, statusCode }) => {
        const span = (request.raw as Record<symbol, Span>)[SPAN]
        if (!span) return
        span.setAttribute('http.status_code', statusCode)
        span.setStatus(statusCode >= 500 ? 'error' : 'ok')
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
