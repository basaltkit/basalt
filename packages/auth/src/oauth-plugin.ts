import { createToken, ctx, definePlugin, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/fastify'
import { z } from 'zod'
import { AUTH } from './plugin.js'
import { OAuth, type OAuthOptions, type OAuthProvider } from './oauth.js'

export const OAUTH = createToken<OAuth>('auth.oauth')

export interface OAuthPluginOptions extends Omit<OAuthOptions, never> {
  providers: OAuthProvider[]
}

/**
 * Registers the {@link OAuth} service (token {@link OAUTH}). Pair it with
 * {@link oauthRoutes} and register both AFTER `authPlugin` — the service resolves
 * `AUTH` to log users in.
 */
export function oauthPlugin(options: OAuthPluginOptions) {
  const { providers, ...oauthOptions } = options
  return definePlugin({
    name: 'basalt:auth:oauth',
    register({ container }) {
      container.singleton(OAUTH, (c) => new OAuth(c.get(AUTH), providers, oauthOptions))
    },
  })
}

export interface OAuthRoutesOptions {
  /**
   * Base URL of your deployed app. The provider redirect_uri is built as
   * `${callbackBaseUrl}/auth/oauth/:provider/callback` and must be registered
   * with each provider.
   */
  callbackBaseUrl: string
  /**
   * When set, the callback redirects the browser here after a successful login
   * with `#access_token=…&refresh_token=…` in the fragment (for SPA flows).
   * When omitted, the callback responds with JSON `{ user, accessToken, refreshToken }`.
   */
  successRedirect?: string
}

/**
 * Ready-made OAuth routes:
 *  - `GET /auth/oauth/:provider` → 302 to the provider's authorize URL.
 *  - `GET /auth/oauth/:provider/callback` → exchanges the code and logs in.
 */
export function oauthRoutes(options: OAuthRoutesOptions): BasaltRoute[] {
  const oauth = () => (ctx().container as Container).get(OAUTH)
  const base = options.callbackBaseUrl.replace(/\/+$/, '')
  const redirectUri = (provider: string): string => `${base}/auth/oauth/${provider}/callback`

  return [
    route({
      method: 'GET',
      url: '/auth/oauth/:provider',
      params: z.object({ provider: z.string() }),
      async handler({ params, reply }) {
        const url = oauth().authorizeUrl(params.provider, redirectUri(params.provider))
        return reply.code(302).header('location', url).send()
      },
    }),
    route({
      method: 'GET',
      url: '/auth/oauth/:provider/callback',
      params: z.object({ provider: z.string() }),
      query: z.object({ code: z.string(), state: z.string() }),
      async handler({ params, query, reply }) {
        const { user, tokens } = await oauth().callback(params.provider, {
          code: query.code,
          state: query.state,
          redirectUri: redirectUri(params.provider),
        })
        if (options.successRedirect) {
          const url = new URL(options.successRedirect)
          url.hash = new URLSearchParams({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
          }).toString()
          return reply.code(302).header('location', url.toString()).send()
        }
        return { user, ...tokens }
      },
    }),
  ]
}
