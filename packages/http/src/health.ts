import { definePlugin } from '@basaltkit/core'
import { HTTP_SERVER } from './server.js'

export interface HealthReport {
  ok: boolean
  detail?: string
}

export type HealthCheck = () => HealthReport | Promise<HealthReport>

export interface HealthPluginOptions {
  checks?: Record<string, HealthCheck>
  livePath?: string
  readyPath?: string
}

/**
 * Kubernetes-style probes, framework-neutral (Fastify/Express/Hono):
 * - `/livez` — the process is up; never touches dependencies.
 * - `/readyz` — every check passes, else `503` with a per-check breakdown.
 */
export function healthPlugin(options: HealthPluginOptions = {}) {
  const checks = options.checks ?? {}
  return definePlugin({
    name: 'basalt:health',
    boot({ container }) {
      const server = container.get(HTTP_SERVER)

      server.addRoute('GET', options.livePath ?? '/livez', () => ({ status: 'ok' }))

      server.addRoute('GET', options.readyPath ?? '/readyz', async ({ reply }) => {
        const results = await Promise.all(
          Object.keys(checks).map(async (name) => {
            try {
              return [name, await checks[name]!()] as const
            } catch (error) {
              return [name, { ok: false, detail: error instanceof Error ? error.message : String(error) }] as const
            }
          }),
        )
        const ok = results.every(([, report]) => report.ok)
        const body = { status: ok ? 'ok' : 'unavailable', checks: Object.fromEntries(results) }
        return ok ? body : reply.code(503).send(body)
      })
    },
  })
}
