import { createApp, definePlugin } from '@machize/core'
import { configPlugin } from '@machize/config'
import { EVENTS, eventsPlugin } from '@machize/events'
import { fastifyPlugin } from '@machize/fastify'
import { LOGGER, loggerPlugin } from '@machize/logger'
import { AUDIT, PROJECTS, ProjectRepository } from './domain.js'
import { projectRoutes } from './routes.js'

/**
 * Plugin da aplicação: registra serviços de domínio e assina o listener de
 * auditoria — um wildcard que cobre todos os eventos de projeto.
 */
const playgroundPlugin = definePlugin({
  name: 'playground',
  dependsOn: ['machize:events', 'machize:logger'],
  register({ container }) {
    container.singleton(PROJECTS, () => new ProjectRepository())
    container.singleton(AUDIT, () => ({ entries: [] }))
  },
  boot({ container }) {
    const bus = container.get(EVENTS)
    const logger = container.get(LOGGER)
    const audit = container.get(AUDIT)
    bus.on('project.**', (payload, meta) => {
      audit.entries.push({ event: meta.name, payload })
      logger.info({ event: meta.name }, 'audit: evento registrado')
    })
  },
})

export interface BuildAppOptions {
  logLevel?: string
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
      playgroundPlugin,
      fastifyPlugin({ routes: projectRoutes }),
    ],
  })
}
