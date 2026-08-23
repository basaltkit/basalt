import { createApp, definePlugin, tryCtx } from '@basaltkit/core'
import { configPlugin } from '@basaltkit/config'
import { EVENTS, eventsPlugin } from '@basaltkit/events'
import { fastifyPlugin } from '@basaltkit/fastify'
import { mcpPlugin, mcpRoutes } from '@basaltkit/mcp'
import { LOGGER, loggerPlugin, type LogLevel } from '@basaltkit/logger'
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

export interface BuildAppOptions {
  logLevel?: LogLevel
  pretty?: boolean
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
      // Expose the mcp-opted-in routes as MCP tools (POST /mcp), reusing the same
      // pipeline — tenancy included. See src/mcp-stdio.ts for the stdio server.
      mcpPlugin({ routes: projectRoutes, serverInfo: { name: 'playground', version: '1.0.0' } }),
      fastifyPlugin({ routes: [...projectRoutes, ...mcpRoutes()] }),
    ],
  })
}
