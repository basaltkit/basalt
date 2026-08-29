import { route, type BasaltRoute } from '@basaltkit/http'
import { apiKeysPageCsp, apiKeysPageHtml, type ApiKeysPageOptions } from './html.js'

export interface ApiKeysUiOptions extends ApiKeysPageOptions {
  /** Where to mount the page. Default `/apikeys/ui`. */
  path?: string
  /**
   * Content-Security-Policy for the page. Default: the hash-locked
   * {@link apiKeysPageCsp}, so the page works under `securityPlugin`'s strict
   * app-wide CSP without weakening it. Pass a string to override, or `false`
   * to send no route-scoped CSP at all.
   */
  csp?: string | false
}

/**
 * Serves the API-keys management page at `GET /apikeys/ui` (requires a
 * logged-in user). Pair with `@basaltkit/auth`'s `apiKeyRoutes()`, which provides
 * the JSON endpoints the page calls.
 */
export function apiKeysUiRoutes(options: ApiKeysUiOptions = {}): BasaltRoute[] {
  const html = apiKeysPageHtml(options)
  const csp = options.csp === false ? undefined : (options.csp ?? apiKeysPageCsp(options))
  return [
    route({
      method: 'GET',
      url: options.path ?? '/apikeys/ui',
      meta: { auth: true },
      async handler({ reply }) {
        if (csp !== undefined) reply.header('content-security-policy', csp)
        return reply.header('content-type', 'text/html; charset=utf-8').send(html)
      },
    }),
  ]
}
