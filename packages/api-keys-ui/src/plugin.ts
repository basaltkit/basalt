import { route, type MachizeRoute } from '@machize/fastify'
import { apiKeysPageHtml, type ApiKeysPageOptions } from './html.js'

export interface ApiKeysUiOptions extends ApiKeysPageOptions {
  /** Where to mount the page. Default `/apikeys/ui`. */
  path?: string
}

/**
 * Serves the API-keys management page at `GET /apikeys/ui` (requires a
 * logged-in user). Pair with `@machize/auth`'s `apiKeyRoutes()`, which provides
 * the JSON endpoints the page calls.
 */
export function apiKeysUiRoutes(options: ApiKeysUiOptions = {}): MachizeRoute[] {
  const html = apiKeysPageHtml(options)
  return [
    route({
      method: 'GET',
      url: options.path ?? '/apikeys/ui',
      meta: { auth: true },
      async handler({ reply }) {
        return reply.header('content-type', 'text/html; charset=utf-8').send(html)
      },
    }),
  ]
}
