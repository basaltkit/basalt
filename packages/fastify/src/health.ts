import { definePlugin } from '@machize/core'
import type { FastifyInstance } from 'fastify'
import { FASTIFY } from './adapter.js'

export interface HealthReport {
  ok: boolean
  /** Optional human detail, surfaced in the readiness response. */
  detail?: string
}

export type HealthCheck = () => HealthReport | Promise<HealthReport>

export interface HealthPluginOptions {
  /** Named dependency checks (db, redis, …) run by the readiness probe. */
  checks?: Record<string, HealthCheck>
  /** Liveness path (process is up). Default '/livez'. */
  livePath?: string
  /** Readiness path (dependencies are reachable). Default '/readyz'. */
  readyPath?: string
}

/**
 * Kubernetes-style probes, distinct on purpose:
 * - **liveness** (`/livez`): the process is running — never touches dependencies,
 *   so a slow database never triggers a pod restart loop.
 * - **readiness** (`/readyz`): every registered check passes — returns 503 with a
 *   per-check breakdown otherwise, so load balancers drain the instance.
 *
 * healthPlugin({ checks: { db: () => ({ ok: pool.healthy }) } })
 */
export function healthPlugin(options: HealthPluginOptions = {}) {
  const checks = options.checks ?? {}

  return definePlugin({
    name: 'machize:health',
    dependsOn: ['machize:fastify'],
    boot({ container }) {
      const app: FastifyInstance = container.get(FASTIFY)

      app.route({
        method: 'GET',
        url: options.livePath ?? '/livez',
        handler: async () => ({ status: 'ok' }),
      })

      app.route({
        method: 'GET',
        url: options.readyPath ?? '/readyz',
        handler: async (_request, reply) => {
          const names = Object.keys(checks)
          const results = await Promise.all(
            names.map(async (name) => {
              try {
                const report = await checks[name]!()
                return [name, report] as const
              } catch (error) {
                return [name, { ok: false, detail: error instanceof Error ? error.message : String(error) }] as const
              }
            }),
          )
          const ok = results.every(([, report]) => report.ok)
          const body = {
            status: ok ? 'ok' : 'unavailable',
            checks: Object.fromEntries(results),
          }
          return ok ? body : reply.code(503).send(body)
        },
      })
    },
  })
}
