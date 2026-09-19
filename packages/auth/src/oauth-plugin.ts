import { createToken, ctx, definePlugin, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { AUTH } from './plugin.js'
import { OAuth, type OAuthOptions, type OAuthProvider, stripTrailingSlashes } from './oauth.js'

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
  /**
   * The HttpOnly cookie that binds a login to the browser that started it.
   * `secure` defaults to production-only; when secure, the cookie is named
   * `__Host-basalt_oauth` (host-only, so a sibling subdomain cannot plant it).
   */
  bindingCookie?: { secure?: boolean; maxAgeSeconds?: number }
}

const readCookie = (header: unknown, name: string): string | undefined => {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name && rest.length > 0) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * Ready-made OAuth routes:
 *  - `GET /auth/oauth/:provider` → 302 to the provider's authorize URL.
 *  - `GET /auth/oauth/:provider/callback` → exchanges the code and logs in.
 */
export function oauthRoutes(options: OAuthRoutesOptions): BasaltRoute[] {
  const oauth = () => (ctx().container as Container).get(OAUTH)
  const base = stripTrailingSlashes(options.callbackBaseUrl)
  const redirectUri = (provider: string): string => `${base}/auth/oauth/${provider}/callback`
  const secure = options.bindingCookie?.secure ?? process.env['NODE_ENV'] === 'production'
  const cookieName = secure ? '__Host-basalt_oauth' : 'basalt_oauth'
  const maxAge = options.bindingCookie?.maxAgeSeconds ?? 15 * 60
  // SameSite=Lax: the provider redirects back with a top-level GET, which Lax allows.
  const cookie = (value: string, age: number): string =>
    `${cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`

  return [
    route({
      method: 'GET',
      url: '/auth/oauth/:provider',
      params: z.object({ provider: z.string() }),
      async handler({ params, reply }) {
        const { url, binding } = oauth().authorize(params.provider, redirectUri(params.provider))
        return reply.code(302).header('set-cookie', cookie(binding, maxAge)).header('location', url).send()
      },
    }),
    route({
      method: 'GET',
      url: '/auth/oauth/:provider/callback',
      params: z.object({ provider: z.string() }),
      query: z.object({ code: z.string().max(4096), state: z.string().max(4096) }),
      async handler({ params, query, request, reply }) {
        // Single-use: the binding cookie is cleared whatever the outcome.
        reply.header('set-cookie', cookie('', 0))
        const { user, tokens } = await oauth().callback(params.provider, {
          code: query.code,
          state: query.state,
          redirectUri: redirectUri(params.provider),
          binding: readCookie(request.headers.cookie, cookieName),
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
