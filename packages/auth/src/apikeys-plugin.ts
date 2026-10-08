import { BasaltError, createToken, definePlugin, ensureMetadata, type RequestContext } from '@basaltkit/core'
import type { RequestEnricher, RouteGuard } from '@basaltkit/http'
import { ApiKeys, ScopeRequiredError, apiKeyDisplayPrefix, resolveTouchEveryMs, scopesSatisfy, type ApiKeyContext, type ApiKeysOptions } from './apikeys.js'
import { publicUser } from './auth.js'
import type { UserSource } from './stores.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** Set when the request authenticated with an API key instead of a session. */
    apiKey?: ApiKeyContext
  }
  interface BasaltHooks {
    'auth:apikey_issued': { id: string; tenantId?: string; userId?: string }
    'auth:apikey_revoked': { id: string }
    /**
     * A presented API key was refused: unknown/revoked/expired (`invalid`), used
     * outside the tenant it is bound to (`tenant_mismatch`), used on a
     * session-only route (`not_allowed`) or beyond its scopes (`scope`). Never
     * carries the key itself.
     *
     * For an `invalid` key, `prefix` is the presented key's display prefix
     * (`mk_live_` plus six characters, what listings show; never the secret)
     * and `ip` the client address, so an app can throttle or alert per caller.
     * This event is excluded from `auditPlugin`'s default hook capture: any
     * unauthenticated client can trigger it on every request.
     */
    'auth:apikey_rejected': {
      id?: string
      reason: 'invalid' | 'tenant_mismatch' | 'not_allowed' | 'scope'
      tenantId?: string
      prefix?: string
      ip?: string
    }
  }
}

declare module '@basaltkit/http' {
  interface RouteMeta {
    /**
     * `false` makes the route session-only: requests authenticated with an API
     * key are refused (403 `AUTH_APIKEY_NOT_ALLOWED`), whatever the key's scopes.
     * Key management and MFA routes declare it.
     */
    apiKey?: boolean
  }
}

/** The key is bound to another tenant than the one this request resolved. */
export class ApiKeyTenantMismatchError extends BasaltError {
  readonly status = 403
  constructor() {
    super('AUTH_APIKEY_TENANT_MISMATCH', 'This API key is not valid for this tenant.')
  }
}

/**
 * The request presented two DIFFERENT API keys (`Authorization: Bearer mk_…`
 * and the key header). Neither is picked: which credential authorizes a
 * request must never depend on header precedence.
 */
export class ApiKeyAmbiguousError extends BasaltError {
  readonly status = 400
  constructor() {
    super('AUTH_APIKEY_AMBIGUOUS', 'Two different API keys were presented; send exactly one.')
  }
}

/**
 * A presented API key is unknown, revoked, expired or malformed. Thrown only
 * with `apiKeysPlugin({ rejectInvalid: true })`; by default such a request
 * continues as anonymous.
 */
export class ApiKeyInvalidError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_APIKEY_INVALID', 'The API key is invalid, revoked or expired.')
  }
}

/** RFC 6750 challenge sent with {@link ApiKeyInvalidError}. */
const INVALID_TOKEN_CHALLENGE = 'Bearer error="invalid_token"'

/** The route only accepts an interactive session, not an API key. */
export class ApiKeyNotAllowedError extends BasaltError {
  readonly status = 403
  constructor() {
    super('AUTH_APIKEY_NOT_ALLOWED', 'This action requires an interactive session; API keys are not accepted.')
  }
}

/**
 * Route-meta keys that gate a route on the *identity* of the caller. A key that
 * does not hold `*` reaches such a route only when the route also declares
 * `meta.scopes` — otherwise a narrow key would inherit its owner's full powers
 * through `ctx().user`.
 */
const IDENTITY_GATED_META = ['auth', 'can', 'teamRole', 'audience'] as const

export const API_KEYS = createToken<ApiKeys>('auth:apikeys')

export interface ApiKeysPluginOptions extends ApiKeysOptions {
  /**
   * Header carrying the key, besides `Authorization: Bearer mk_...`.
   * Default `x-api-key`. A request carrying two different keys (one in each)
   * is refused with 400 `AUTH_APIKEY_AMBIGUOUS`.
   */
  header?: string
  /**
   * When provided, a key that carries a `userId` also populates `ctx().user`,
   * so scope-guarded routes can read the acting user.
   */
  users?: UserSource
  /**
   * Keys issued without a tenant (machine/platform keys) are refused on any
   * request that resolved a tenant, so they cannot be pointed at an arbitrary
   * tenant through `x-tenant-id`, a subdomain or the Host. Set `true` only for
   * trusted platform keys that must act across tenants. Default false.
   */
  allowTenantlessKeys?: boolean
  /**
   * By default a key that does not hold `*` is refused on routes gated by
   * `meta.auth`/`can`/`teamRole`/`audience` unless the route also declares
   * `meta.scopes` — scopes are an upper bound, not a label. `true` restores the
   * old behaviour where any key with a `userId` acts as its owner. Default false.
   */
  allowNarrowKeysOnUnscopedRoutes?: boolean
  /**
   * `true` refuses a request that presents an API key which does not verify
   * (unknown, revoked, expired, malformed) with 401 `AUTH_APIKEY_INVALID` and
   * `WWW-Authenticate: Bearer error="invalid_token"`, before any guard runs. A
   * machine client can then tell "my key is dead" from "this route needs a
   * scope". Default false: the request continues as anonymous and the route's
   * own guards answer (401 `AUTH_REQUIRED`, 403 `AUTH_SCOPE_REQUIRED`, or the
   * public response).
   */
  rejectInvalid?: boolean
}

const tenantOf = (context: RequestContext): string | undefined =>
  (context as { tenant?: { id?: unknown } }).tenant?.id as string | undefined

/**
 * Programmatic access via API keys. Registers an enricher that authenticates
 * `mk_`-prefixed bearers (or the configured header) and a guard that enforces
 * `meta.scopes` on routes. Pair with {@link apiKeyRoutes} for CRUD endpoints.
 */
export function apiKeysPlugin(options: ApiKeysPluginOptions = {}) {
  const header = options.header ?? 'x-api-key'
  return definePlugin({
    name: 'basalt:apikeys',
    register({ container, hooks }) {
      // The ApiKeys singleton is built lazily; fail at boot, not on the first
      // request, on an invalid option.
      resolveTouchEveryMs(options.touchEveryMs)
      container.singleton(API_KEYS, () => new ApiKeys({ ...options, hooks }))
      // A verified social login that adopts a never-verified account distrusts
      // whoever registered it: the keys they may have minted die with the rest
      // of their credentials (Auth revokes passwords, sessions, tokens and MFA).
      hooks.on('auth:social_account_adopted', async ({ user }) => {
        await container.get(API_KEYS).revokeAllForUser(user.id)
      })
      const metadata = ensureMetadata(container)

      const enricher: RequestEnricher = async ({ request, reply, context, container: c }) => {
        const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : undefined
        const authHeader = request.headers.authorization
        const bearer =
          typeof authHeader === 'string' && authHeader.startsWith('Bearer mk_')
            ? authHeader.slice('Bearer '.length)
            : undefined
        const rawCustom = request.headers[header]
        const custom = typeof rawCustom === 'string' && rawCustom.length > 0 ? rawCustom : undefined
        // Both carriers present and disagreeing is refused outright: letting one
        // shadow the other means a stray or injected `Bearer mk_…` silently
        // replaces the key the client meant (and vice versa). Identical values
        // are harmless and accepted.
        if (bearer !== undefined && custom !== undefined && bearer !== custom) {
          await hooks.emit('auth:apikey_rejected', { reason: 'invalid', ...(ip !== undefined ? { ip } : {}) })
          throw new ApiKeyAmbiguousError()
        }
        const presented = bearer ?? custom
        if (!presented) return

        const record = await c.get(API_KEYS).verify(presented)
        if (!record) {
          const prefix = apiKeyDisplayPrefix(presented)
          await hooks.emit('auth:apikey_rejected', {
            reason: 'invalid',
            ...(prefix !== undefined ? { prefix } : {}),
            ...(ip !== undefined ? { ip } : {}),
          })
          if (options.rejectInvalid === true) {
            reply?.header('WWW-Authenticate', INVALID_TOKEN_CHALLENGE)
            throw new ApiKeyInvalidError()
          }
          return
        }

        context.apiKey = {
          id: record.id,
          scopes: record.scopes,
          ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
          ...(record.userId !== undefined ? { userId: record.userId } : {}),
        }
        if (record.userId && options.users) {
          const user = await options.users.findById(record.userId)
          if (user) context.user = publicUser(user)
        }
      }
      metadata.add('http:enrichers', enricher)

      // Guard (runs after every enricher, so ctx().tenant is resolved): binds the
      // key to its tenant, refuses keys on session-only routes, and enforces
      // meta.scopes as an upper bound on what a key may reach.
      const guard: RouteGuard = async ({ route, context }) => {
        const key = context.apiKey
        const meta = route.meta as Record<string, unknown> | undefined
        if (key) {
          const reject = async (reason: 'tenant_mismatch' | 'not_allowed' | 'scope', error: Error) => {
            const tenantId = tenantOf(context)
            await hooks.emit('auth:apikey_rejected', { id: key.id, reason, ...(tenantId !== undefined ? { tenantId } : {}) })
            throw error
          }
          const tenantId = tenantOf(context)
          if (key.tenantId !== undefined) {
            // A tenant-bound key works only inside that tenant — never in another
            // one picked by the client, and never outside any tenant.
            if (tenantId !== key.tenantId) await reject('tenant_mismatch', new ApiKeyTenantMismatchError())
          } else if (tenantId !== undefined && options.allowTenantlessKeys !== true) {
            await reject('tenant_mismatch', new ApiKeyTenantMismatchError())
          }
          if (meta?.['apiKey'] === false) await reject('not_allowed', new ApiKeyNotAllowedError())

          const declared = meta?.['scopes']
          const hasScopes = Array.isArray(declared) && declared.length > 0
          if (
            !hasScopes &&
            options.allowNarrowKeysOnUnscopedRoutes !== true &&
            !key.scopes.includes('*') &&
            IDENTITY_GATED_META.some((k) => meta?.[k] !== undefined && meta?.[k] !== false)
          ) {
            await reject('scope', new ScopeRequiredError('*'))
          }
        }

        // A route declaring meta.scopes needs an API key holding them all.
        const required = meta?.['scopes']
        if (!Array.isArray(required) || required.length === 0) return
        const granted = key?.scopes ?? []
        for (const scope of required as string[]) {
          if (!scopesSatisfy(granted, [scope])) {
            if (key) await hooks.emit('auth:apikey_rejected', { id: key.id, reason: 'scope' })
            throw new ScopeRequiredError(scope)
          }
        }
      }
      metadata.add('http:guards', guard)
      // Claim `meta.scopes` for the adapters' boot-time guarded-meta check —
      // a scope-gated route without this plugin would serve unchecked.
      metadata.add('http:guarded-meta', 'scopes')
    },
  })
}
