import { BasaltError, type RequestContext } from '@basaltkit/core'
import type { JwtClaims } from './jwt.js'
import type { PublicUser } from './stores.js'

/**
 * Claim names Basalt owns in an access token. A {@link TokenClaimsFn} that
 * returns one of them fails the sign-in with {@link ReservedTokenClaimError}:
 * a custom claim must never overwrite the subject, the expiry, the token
 * version or the authentication methods.
 */
export const RESERVED_TOKEN_CLAIMS: readonly string[] = Object.freeze([
  'sub',
  'tv',
  'amr',
  'iat',
  'exp',
  'nbf',
  'iss',
  'aud',
  'jti',
])

/** Why an access token is being signed. */
export type TokenClaimsReason = 'login' | 'social' | 'refresh'

export interface TokenClaimsContext {
  /** `login` (password, with or without MFA), `social` (OAuth / SSO) or `refresh` (rotation). */
  reason: TokenClaimsReason
  /** Authentication methods of the credential (`pwd`, `fed`, `mfa`), when known. */
  amr?: string[]
  /** The ambient context (`ctx()`), absent outside a request / `runWithContext`. */
  request?: RequestContext
}

/**
 * Extra claims for every access token Auth signs — login, social login, MFA
 * completion and every refresh. Called again on each refresh (the claims are
 * re-derived, not copied), so a refreshed token carries the same claims as
 * long as the inputs (the user, the context) are the same. Throwing fails the
 * sign-in (fail closed). Returned values must be JSON-serialisable.
 */
export type TokenClaimsFn = (
  user: PublicUser,
  context: TokenClaimsContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>

/**
 * Checks a verified access token's claims on the request it authenticates.
 * `false` refuses the token with 401 {@link TokenClaimsRejectedError}.
 * Runs before the user lookup, so a refused token never reads its `sub`.
 */
export type VerifyClaimsFn = (claims: JwtClaims, context: RequestContext) => boolean | Promise<boolean>

/** A {@link TokenClaimsFn} returned a claim Basalt reserves (a bug in the app, 500). */
export class ReservedTokenClaimError extends BasaltError {
  readonly status = 500
  constructor(claim: string) {
    super('AUTH_TOKEN_CLAIM_RESERVED', `The access-token claim "${claim}" is reserved and cannot be set by tokenClaims.`)
  }
}

/** A signed, unexpired access token whose claims `verifyClaims` refused. */
export class TokenClaimsRejectedError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_TOKEN_CLAIMS_REJECTED', 'The token is not valid here.')
  }
}

/** Validates what a {@link TokenClaimsFn} returned. Internal to the package. */
export function checkCustomClaims(claims: unknown): Record<string, unknown> {
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new TypeError('tokenClaims must return a plain object of claims.')
  }
  for (const name of Object.keys(claims)) {
    if (RESERVED_TOKEN_CLAIMS.includes(name)) throw new ReservedTokenClaimError(name)
  }
  return claims as Record<string, unknown>
}

/** The tenant id of a context, read structurally (auth never imports tenancy). */
const tenantIdOf = (context: RequestContext | undefined): string | null => {
  const id = (context as { tenant?: { id?: unknown } } | undefined)?.tenant?.id
  return typeof id === 'string' && id !== '' ? id : null
}

export interface TenantBoundTokensOptions {
  /** The claim that carries the tenant id. Default `tid`. Must not be reserved. */
  claim?: string
  /** More claims of the app's own, merged with the tenant claim. */
  tokenClaims?: TokenClaimsFn
  /** A further check of the app's own, run after the tenant check passed. */
  verifyClaims?: VerifyClaimsFn
}

/**
 * Binds access tokens to the plane they were issued on. Spread the result into
 * `authPlugin({ ...tenantBoundTokens() })`:
 *
 * - every access token carries `tid` — the tenant of the context it was
 *   issued in (`ctx().tenant.id`, set by `@basaltkit/tenancy`), or `null` on
 *   the central plane;
 * - a bearer token is accepted only where `tid` equals the tenant resolved for
 *   the request (`null` = no tenant). Anywhere else — another tenant, the apex,
 *   a token issued before the binding (no `tid`) — it is a 401
 *   `AUTH_TOKEN_CLAIMS_REJECTED`, whatever user ids the target plane holds.
 *
 * Works with any tenancy that puts `{ id }` on `ctx().tenant`; auth does not
 * depend on `@basaltkit/tenancy`. Register `tenancyPlugin` before `authPlugin`
 * so the tenant is resolved when the token is checked. Sessions and API keys
 * are unaffected (they are looked up in the plane's own store).
 */
export function tenantBoundTokens(options: TenantBoundTokensOptions = {}): {
  tokenClaims: TokenClaimsFn
  verifyClaims: VerifyClaimsFn
} {
  const claim = options.claim ?? 'tid'
  if (claim === '' || RESERVED_TOKEN_CLAIMS.includes(claim)) throw new ReservedTokenClaimError(claim)
  const extra = options.tokenClaims
  const verify = options.verifyClaims
  return {
    async tokenClaims(user, context) {
      const own = extra ? checkCustomClaims(await extra(user, context)) : {}
      return { ...own, [claim]: tenantIdOf(context.request) }
    },
    async verifyClaims(claims, context) {
      if (claims[claim] !== tenantIdOf(context)) return false
      return verify ? (await verify(claims, context)) === true : true
    },
  }
}
