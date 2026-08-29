import { createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import type { RequestEnricher, RouteGuard } from '@basaltkit/http'
import { Auth, AuthRequiredError, type AuthOptions } from './auth.js'
import { publicUser } from './auth.js'
import type { PublicUser } from './stores.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** The authenticated user of the current request, set by auth. */
    user?: PublicUser
  }
  interface BasaltHooks {
    'auth:registered': { user: PublicUser }
    /**
     * Someone tried to register an email that already has an account. Emitted by
     * the enumeration-safe register endpoint so the app can email the address
     * ("you already have an account — sign in or reset your password") instead of
     * revealing existence in the HTTP response. Only the email is provided.
     */
    'auth:register_existing_email': { email: string }
    'auth:login': { user: PublicUser }
    'auth:login_failed': { email: string }
    'auth:logout': { user: PublicUser }
    /** Email verification requested — the app emails the token as a link. */
    'auth:verify_requested': { user: PublicUser; token: string }
    'auth:email_verified': { user: PublicUser }
    /** Password reset requested — the app emails the token as a link. */
    'auth:password_reset_requested': { user: PublicUser; token: string }
    'auth:password_reset': { user: PublicUser }
    'auth:mfa_enabled': { user: PublicUser }
    'auth:mfa_disabled': { user: PublicUser }
  }
}

export const AUTH = createToken<Auth>('auth')

export type AuthPluginOptions = Omit<AuthOptions, 'hooks'>

export function authPlugin(options: AuthPluginOptions) {
  return definePlugin({
    name: 'basalt:auth',
    register({ container, hooks }) {
      container.singleton(AUTH, () => new Auth({ ...options, hooks }))
      const metadata = ensureMetadata(container)

      // Enricher: authenticates via Bearer JWT or x-session-id header.
      // An explicitly provided invalid token is rejected (401); absence of
      // credentials just leaves the request anonymous.
      const enricher: RequestEnricher = async ({ request, context, container: c }) => {
        const auth = c.get(AUTH)

        const header = request.headers.authorization
        const bearer =
          typeof header === 'string' && header.startsWith('Bearer ')
            ? header.slice('Bearer '.length)
            : undefined
        // `mk_`-prefixed bearers are API keys — left to apiKeysPlugin.
        if (bearer && !bearer.startsWith('mk_')) {
          const claims = await auth.verifyAccessToken(bearer)
          const user = await auth.users.findById(claims.sub)
          if (user) context.user = publicUser(user)
          return
        }

        const sessionId = request.headers['x-session-id']
        if (typeof sessionId === 'string') {
          const user = await auth.sessionUser(sessionId)
          if (user) context.user = publicUser(user)
        }
      }
      metadata.add('http:enrichers', enricher)

      // Guard: routes declaring meta.auth require an authenticated user.
      const guard: RouteGuard = ({ route, context }) => {
        if (route.meta?.['auth'] === true && !context.user) throw new AuthRequiredError()
      }
      metadata.add('http:guards', guard)
      // Claim `meta.auth` so the adapters' boot check knows this key is
      // enforced (routes declaring it without this plugin fail loud at boot).
      metadata.add('http:guarded-meta', 'auth')
    },
  })
}
