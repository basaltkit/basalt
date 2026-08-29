import { route, type BasaltRoute } from '@basaltkit/http'
import { teamsPageCsp, teamsPageHtml, type TeamsPageOptions } from './html.js'

export interface TeamsUiOptions extends TeamsPageOptions {
  /** Where to mount the page. Default `/team/ui`. */
  path?: string
  /**
   * Content-Security-Policy for the page. Default: the hash-locked
   * {@link teamsPageCsp}. Pass a string to override, or `false` to send none.
   */
  csp?: string | false
}

/**
 * Serves the team management page at `GET /team/ui` (requires a logged-in user;
 * add your own admin `teamRole` guard). Pair with `@basaltkit/teams`'
 * `teamRoutes()`, which provides the JSON endpoints the page calls.
 */
export function teamsUiRoutes(options: TeamsUiOptions = {}): BasaltRoute[] {
  const html = teamsPageHtml(options)
  const csp = options.csp === false ? undefined : (options.csp ?? teamsPageCsp(options))
  return [
    route({
      method: 'GET',
      url: options.path ?? '/team/ui',
      meta: { auth: true },
      async handler({ reply }) {
        if (csp !== undefined) reply.header('content-security-policy', csp)
        return reply.header('content-type', 'text/html; charset=utf-8').send(html)
      },
    }),
  ]
}
