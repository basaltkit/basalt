import { createToken, definePlugin, ensureMetadata } from '@machize/core'
import type { RequestEnricher, RouteGuard } from '@machize/fastify'
import { Auth, AuthRequiredError, type AuthOptions } from './auth.js'
import { publicUser } from './auth.js'
import type { PublicUser } from './stores.js'

declare module '@machize/core' {
  interface RequestContext {
    /** The authenticated user of the current request, set by auth. */
    user?: PublicUser
  }
  interface MachizeHooks {
    'auth:registered': { user: PublicUser }
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
    name: 'machize:auth',
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
          const claims = auth.verifyAccess(bearer)
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
    },
  })
}
