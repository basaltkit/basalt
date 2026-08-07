import { route, type MachizeRoute } from '@machize/fastify'
import { teamsPageHtml, type TeamsPageOptions } from './html.js'

export interface TeamsUiOptions extends TeamsPageOptions {
  /** Where to mount the page. Default `/team/ui`. */
  path?: string
}

/**
 * Serves the team management page at `GET /team/ui` (requires a logged-in user;
 * add your own admin `teamRole` guard). Pair with `@machize/teams`'
 * `teamRoutes()`, which provides the JSON endpoints the page calls.
 */
export function teamsUiRoutes(options: TeamsUiOptions = {}): MachizeRoute[] {
  const html = teamsPageHtml(options)
  return [
    route({
      method: 'GET',
      url: options.path ?? '/team/ui',
      meta: { auth: true },
      async handler({ reply }) {
        return reply.header('content-type', 'text/html; charset=utf-8').send(html)
      },
    }),
  ]
}
