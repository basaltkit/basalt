import { createApp, definePlugin, tryCtx, type BasaltPlugin } from '@basaltkit/core'
import { configPlugin } from '@basaltkit/config'
import { EVENTS, eventsPlugin } from '@basaltkit/events'
import { fastifyPlugin } from '@basaltkit/fastify'
import { expressPlugin } from '@basaltkit/express'
import { honoPlugin } from '@basaltkit/hono'
import { LOGGER, loggerPlugin, type LogLevel } from '@basaltkit/logger'
import type { BasaltRoute } from '@basaltkit/http'
import {
  headerResolver,
  MemoryTenantSource,
  subdomainResolver,
  tenancyPlugin,
} from '@basaltkit/tenancy'
import { AUDIT, PROJECTS, ProjectRepository } from './domain.js'
import { projectRoutes } from './routes.js'

/** Seeded tenants — a real app loads them from its database. */
export const tenants = () =>
  new MemoryTenantSource()
    .add({ id: 'acme', name: 'Acme Inc' })
    .add({ id: 'globex', name: 'Globex Corp' })

/**
 * Application plugin: registers domain services and subscribes the audit
 * listener — a wildcard covering all project events.
 */
const playgroundPlugin = definePlugin({
  name: 'playground',
  dependsOn: ['basalt:events', 'basalt:logger'],
  register({ container }) {
    container.singleton(PROJECTS, () => new ProjectRepository())
    container.singleton(AUDIT, () => ({ entries: [] }))
  },
  boot({ container }) {
    const bus = container.get(EVENTS)
    const logger = container.get(LOGGER)
    const audit = container.get(AUDIT)
    bus.on('project.**', (payload, meta) => {
      // tenant comes from the ALS context — the emitter never passes it
      audit.entries.push({ event: meta.name, payload, tenantId: tryCtx()?.tenant?.id ?? null })
      logger.info({ event: meta.name }, 'audit: event recorded')
    })
  },
})

/** The HTTP runtime to mount. The routes, plugins and domain are identical for all three. */
export type Adapter = 'fastify' | 'express' | 'hono'

/** Same neutral `route()` list, bound to whichever adapter is chosen. */
function httpPlugin(adapter: Adapter, routes: BasaltRoute[]): BasaltPlugin {
  switch (adapter) {
    case 'express':
      return expressPlugin({ routes })
    case 'hono':
      return honoPlugin({ routes })
    default:
      return fastifyPlugin({ routes })
  }
}

export interface BuildAppOptions {
  logLevel?: LogLevel
  pretty?: boolean
  /** Which HTTP adapter to mount. Default `fastify`. */
  adapter?: Adapter
}

export function buildApp(options: BuildAppOptions = {}) {
  return createApp({
    plugins: [
      configPlugin({ app: { name: 'playground' } }),
      loggerPlugin({
        level: options.logLevel ?? 'info',
        ...(options.pretty ? { pretty: true } : {}),
      }),
      eventsPlugin(),
      // Resolution order: explicit header first, then subdomain
      // (acme.localhost works out of the box in dev).
      tenancyPlugin({
        source: tenants(),
        resolvers: [headerResolver(), subdomainResolver({ base: 'localhost' })],
      }),
      playgroundPlugin,
      // The one line that differs per runtime — everything above is adapter-neutral.
      httpPlugin(options.adapter ?? 'fastify', projectRoutes),
    ],
  })
}
