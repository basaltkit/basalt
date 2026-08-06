import { createToken, definePlugin, MetricsRegistry } from '@machize/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { FASTIFY } from './adapter.js'

export const METRICS = createToken<MetricsRegistry>('metrics')

export interface MetricsPluginOptions {
  /** Exposition path. Default '/metrics'. */
  path?: string
  /** Bring your own registry (shared with app code). Default: a fresh one. */
  registry?: MetricsRegistry
  /** Auto-instrument HTTP requests (count, duration, in-flight). Default true. */
  instrumentHttp?: boolean
}

/**
 * Exposes a Prometheus `/metrics` endpoint backed by {@link MetricsRegistry},
 * and (by default) auto-instruments every request with:
 * - `http_requests_total{method,route,status}` (counter)
 * - `http_request_duration_seconds{method,route}` (histogram)
 * - `http_requests_in_flight` (gauge)
 *
 * Routes are labelled by their **template** (`/users/:id`), never the raw URL,
 * so label cardinality stays bounded. Resolve `METRICS` to record your own.
 */
export function metricsPlugin(options: MetricsPluginOptions = {}) {
  const registry = options.registry ?? new MetricsRegistry()
  const instrument = options.instrumentHttp ?? true

  return definePlugin({
    name: 'machize:metrics',
    dependsOn: ['machize:fastify'],
    register({ container }) {
      container.singleton(METRICS, () => registry)
    },
    boot({ container }) {
      const app: FastifyInstance = container.get(FASTIFY)

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

        app.addHook('onRequest', async () => inFlight.inc())
        app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
          inFlight.dec()
          const route = request.routeOptions?.url ?? 'unknown'
          const method = request.method
          total.inc({ method, route, status: String(reply.statusCode) })
          duration.observe(reply.elapsedTime / 1000, { method, route })
        })
      }

      app.route({
        method: 'GET',
        url: options.path ?? '/metrics',
        handler: async (_request, reply) => {
          void reply.header('Content-Type', 'text/plain; version=0.0.4')
          return registry.render()
        },
      })
    },
  })
}
