import { BasaltError, createToken, definePlugin, ensureMetadata, type RequestContext } from '@basaltkit/core'
import type { HttpRequest, RequestEnricher, RouteGuard } from '@basaltkit/http'
import {
  Auth,
  AuthRequiredError,
  isAmr,
  MfaEnrollmentRequiredError,
  MfaStepUpRequiredError,
  type AuthOptions,
} from './auth.js'
import { publicUser } from './auth.js'
import type { PublicUser } from './stores.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** The authenticated user of the current request, set by auth. */
    user?: PublicUser
    /**
     * Authentication methods of the current credential (`pwd`, `fed`, `mfa`),
     * from the access token's `amr` claim or the session. Absent for API keys
     * and for tokens / sessions issued without it.
     */
    amr?: string[]
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
    /** A wrong MFA code was presented for this user (login or social login). */
    'auth:mfa_failed': { userId: string }
    /** A login was refused because the account (or the client ip) is locked. */
    'auth:locked_out': { email: string; ip?: string }
    /** A consumed refresh token came back; its whole family was revoked (theft indicator). */
    'auth:refresh_reused': { userId: string; familyId: string }
    /**
     * A provider-verified social login took over an account whose email had
     * never been verified; its previous password, sessions, refresh tokens and
     * MFA were revoked.
     */
    'auth:social_account_adopted': { user: PublicUser }
  }
}

export const AUTH = createToken<Auth>('auth')

/** A cookie-authenticated, state-changing request came from another origin. */
export class CsrfRejectedError extends BasaltError {
  readonly status = 403
  constructor() {
    super('AUTH_CSRF_REJECTED', 'Cross-site request refused: the session cookie cannot authorize it.')
  }
}

export interface CsrfOptions {
  /**
   * Extra origins (scheme://host[:port]) allowed to send cookie-authenticated
   * unsafe requests — e.g. a front-end on a sibling subdomain. The request's
   * own origin (its Host / X-Forwarded-Host) is always allowed.
   */
  trustedOrigins?: string[]
}

export interface AuthPluginOptions extends Omit<AuthOptions, 'hooks'> {
  /**
   * CSRF defence for the session cookie (on by default). A request whose ONLY
   * credential is the ambient session cookie and whose method is not
   * GET/HEAD/OPTIONS is not authenticated when the browser says it is
   * cross-site or same-site (`Sec-Fetch-Site`), or when its `Origin` is neither
   * the request's own host nor a trusted origin; a route requiring auth then
   * answers 403 `AUTH_CSRF_REJECTED`. Bearer tokens, `x-session-id` and API keys
   * are not ambient and are not affected. `false` disables the check.
   */
  csrf?: CsrfOptions | false
  /**
   * Require multi-factor authentication. `true` for every user, or a policy
   * `(user, context) => boolean | Promise<boolean>` (e.g. only admins, only
   * some tenants). An authenticated request whose credential was not obtained
   * with a second factor (`ctx().amr` lacks `mfa`) is refused with 403
   * `AUTH_MFA_ENROLLMENT_REQUIRED` (the account has no MFA yet — enrol, then
   * sign in again) or `AUTH_MFA_REQUIRED` (sign in again with a code).
   *
   * Routes declaring `meta.mfa: false` are exempt — every `authRoutes()` route
   * and the enrol / activate / status routes of `mfaRoutes()`, so a user can
   * still sign in, read `/auth/me`, enrol and log out. API-key requests are not
   * subject to the policy (a key is a machine credential; minting one needs an
   * MFA session under the policy). Independently of the policy, `meta.mfa: true`
   * requires MFA on a single route (step-up). Default: off.
   */
  requireMfa?: boolean | ((user: PublicUser, context: RequestContext) => boolean | Promise<boolean>)
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const headerOf = (request: HttpRequest, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}
const originOf = (value: string): string | null => {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`.toLowerCase()
  } catch {
    return null
  }
}

/** Whether a cookie-authenticated request may change state (CSRF check). */
function sameOriginRequest(request: HttpRequest, trusted: ReadonlySet<string>): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true
  const origin = headerOf(request, 'origin')
  const normalized = origin && origin !== 'null' ? originOf(origin) : null
  if (normalized && trusted.has(normalized)) return true
  // Sec-Fetch-Site is set by the browser alone (a page cannot forge it), so it
  // settles the question when present — including behind a proxy that rewrites Host.
  const site = headerOf(request, 'sec-fetch-site')?.toLowerCase()
  if (site === 'same-origin' || site === 'none') return true
  if (site === 'cross-site' || site === 'same-site') return false
  if (origin === undefined) return true // no browser metadata: not a browser-forged request
  if (!normalized) return false // `Origin: null` (sandboxed/opaque) or garbage
  const host = normalized.slice(normalized.indexOf('//') + 2)
  const own = [headerOf(request, 'host'), headerOf(request, 'x-forwarded-host')]
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.split(',')[0]!.trim().toLowerCase())
  return own.includes(host)
}

/** Requests whose session cookie was ignored by the CSRF check. */
const csrfRejected = new WeakSet<RequestContext>()

/**
 * Whether the request's session cookie failed the CSRF check (so it must not
 * be acted upon — e.g. by `POST /auth/logout`). Internal to the package.
 */
export const isCsrfRejected = (context: RequestContext): boolean => csrfRejected.has(context)

export function authPlugin(pluginOptions: AuthPluginOptions) {
  const { csrf, requireMfa, ...options } = pluginOptions
  const trustedOrigins = new Set(
    (csrf ? (csrf.trustedOrigins ?? []) : []).map((o) => originOf(o)).filter((o): o is string => o !== null),
  )
  return definePlugin({
    name: 'basalt:auth',
    register({ container, hooks }) {
      container.singleton(AUTH, () => new Auth({ ...options, hooks }))
      const metadata = ensureMetadata(container)

      // Enricher: authenticates via Bearer JWT, session cookie, or x-session-id header.
      // An explicitly provided invalid token is rejected (401); absence of
      // credentials just leaves the request anonymous.
      const enricher: RequestEnricher = async ({ request, context, container: c }) => {
        const auth = c.get(AUTH)

        // Evaluate the ambient cookie's CSRF standing up front, whatever other
        // credential the request carries, so routes that act on the cookie
        // itself (logout) can refuse a cross-site one.
        const cookie = request.headers.cookie
        const cookieSessionId = typeof cookie === 'string' ? auth.sessionIdFromCookie(cookie) : null
        if (cookieSessionId && csrf !== false && !sameOriginRequest(request, trustedOrigins)) {
          csrfRejected.add(context)
        }

        const header = request.headers.authorization
        const bearer =
          typeof header === 'string' && header.startsWith('Bearer ')
            ? header.slice('Bearer '.length)
            : undefined
        // `mk_`-prefixed bearers are API keys — left to apiKeysPlugin.
        if (bearer && !bearer.startsWith('mk_')) {
          const claims = await auth.verifyAccessToken(bearer)
          const user = await auth.users.findById(claims.sub)
          if (user) {
            context.user = publicUser(user)
            if (isAmr(claims.amr)) context.amr = claims.amr
          }
          return
        }

        const sessionId = request.headers['x-session-id']
        if (typeof sessionId === 'string') {
          const session = await auth.sessionAuth(sessionId)
          if (session) {
            context.user = publicUser(session.user)
            if (session.amr) context.amr = session.amr
          }
          return
        }

        // Ambient credential on a cross-origin state change: do not use it.
        if (cookieSessionId && !csrfRejected.has(context)) {
          const session = await auth.sessionAuth(cookieSessionId)
          if (session) {
            context.user = publicUser(session.user)
            if (session.amr) context.amr = session.amr
          }
        }
      }
      metadata.add('http:enrichers', enricher)

      // Guard: routes declaring meta.auth require an authenticated user.
      const guard: RouteGuard = ({ route, context }) => {
        if (route.meta?.['auth'] === true && !context.user) {
          throw csrfRejected.has(context) ? new CsrfRejectedError() : new AuthRequiredError()
        }
      }
      metadata.add('http:guards', guard)
      // Claim `meta.auth` so the adapters' boot check knows this key is
      // enforced (routes declaring it without this plugin fail loud at boot).
      metadata.add('http:guarded-meta', 'auth')
      metadata.add('http:guarded-meta', 'mfa')

      // Guard: MFA by policy (`requireMfa`) or per route (`meta.mfa: true`).
      const mfaGuard: RouteGuard = async ({ route, context, container: c }) => {
        const declared = route.meta?.['mfa']
        if (declared === false) return
        const user = context.user
        if (!user) return
        let required = declared === true
        if (!required && requireMfa !== undefined && requireMfa !== false) {
          // A machine credential: the policy is about interactive sign-ins.
          if ((context as { apiKey?: unknown }).apiKey !== undefined) return
          required = requireMfa === true ? true : (await requireMfa(user, context)) === true
        }
        if (!required || context.amr?.includes('mfa')) return
        throw (await c.get(AUTH).isMfaEnabled(user.id)) ? new MfaStepUpRequiredError() : new MfaEnrollmentRequiredError()
      }
      metadata.add('http:guards', mfaGuard)
    },
  })
}
