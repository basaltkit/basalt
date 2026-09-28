import { createToken, definePlugin, MetricsRegistry } from '@basaltkit/core'
import type { HttpRequest } from './route.js'
import { HTTP_SERVER } from './server.js'

export const METRICS = createToken<MetricsRegistry>('metrics')

export interface MetricsPluginOptions {
  path?: string
  registry?: MetricsRegistry
  instrumentHttp?: boolean
}

const routeLabel = (request: HttpRequest): string => request.routePattern ?? 'unknown'

/**
 * Prometheus `/metrics` + auto-instrumented HTTP, framework-neutral. Requests
 * are labelled by route template (from the adapter), keeping cardinality bounded.
 */
export function metricsPlugin(options: MetricsPluginOptions = {}) {
  const registry = options.registry ?? new MetricsRegistry()
  const instrument = options.instrumentHttp ?? true

  return definePlugin({
    name: 'basalt:metrics',
    register({ container }) {
      container.singleton(METRICS, () => registry)
    },
    boot({ container }) {
      const server = container.get(HTTP_SERVER)

      if (instrument) {
        const total = registry.counter('http_requests_total', {
          help: 'Total HTTP requests',
          labelNames: ['method', 'route', 'status'],
        })
        const duration = registry.histogram('http_request_duration_seconds', {
          help: 'HTTP request duration in seconds',
          labelNames: ['method', 'route'],
        })
        const inFlight = registry.gauge('http_requests_in_flight', { help: 'In-flight HTTP requests' })

        // Counted per request, not per hook call: a pre-hook registered before
        // this one can answer on its own (a 429, a CORS preflight), so this
        // `use` never runs while the after-hook still does — the gauge went
        // negative. Only a request this hook counted is ever uncounted, once.
        // The adapter's native request (`raw`) is the one identity the pre and
        // after hooks share; without one, the gauge simply never drops below 0.
        const counted = new WeakSet<object>()
        let untracked = 0
        const identity = (request: HttpRequest): object | undefined =>
          typeof request.raw === 'object' && request.raw !== null ? request.raw : undefined
        server.use(({ request }) => {
          const key = identity(request)
          if (key) counted.add(key)
          else untracked++
          inFlight.inc()
        })
        server.after(({ request, statusCode, durationMs }) => {
          const key = identity(request)
          let release = false
          if (key) release = counted.delete(key)
          else if (untracked > 0) {
            untracked--
            release = true
          }
          if (release) inFlight.dec()
          const route = routeLabel(request)
          total.inc({ method: request.method, route, status: String(statusCode) })
          duration.observe(durationMs / 1000, { method: request.method, route })
        })
      }

      server.addRoute('GET', options.path ?? '/metrics', ({ reply }) => {
        reply.header('Content-Type', 'text/plain; version=0.0.4')
        return registry.render()
      })
    },
  })
}
