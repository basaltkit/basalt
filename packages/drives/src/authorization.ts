import { createHash, createHmac } from 'node:crypto'
import { DriveAuthorizationInvalidError } from './errors.js'
import { randomToken, safeEqual } from './secret-box.js'

/**
 * The connect handshake: build a consent URL, then verify what comes back.
 *
 * `@basaltkit/auth` already has an OAuth client (`packages/auth/src/oauth.ts`)
 * and it is **not** reusable here — a conclusion reached by reading it, not by
 * assuming. `OAuth.callback()` exchanges the code, reads the profile, and calls
 * `auth.socialLogin(...)`; `exchangeCode` returns `{ accessToken, idToken }` and
 * drops the refresh token on the floor. That is correct for its job: it proves
 * *who you are* once, and the session takes over from there. This package needs
 * the opposite — a durable, per-tenant grant to act on a user's files for
 * months, with `offline_access`, rotation, and revocation. Bending the login
 * client into that would change its public return type (a breaking change to a
 * security-critical API) and give it a persistence responsibility it should not
 * have.
 *
 * What *is* reused is its reasoning, because that part was right: a signed,
 * expiring, single-use `state` bound to the browser that started the flow, plus
 * PKCE S256 derived from the same binding. RFC 0002 proposes extracting that
 * shared core so there is one implementation; until then this is a deliberate
 * re-derivation of a pattern, not a copy of code.
 */

/** How long a pending authorization stays valid. */
export const DEFAULT_STATE_TTL_MS = 10 * 60_000

/** What the caller must carry through the flow. */
export interface DriveAuthorizationStart {
  /** Send the browser here. */
  url: string
  /**
   * Store in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie and hand back at the
   * callback. This is what binds the flow to one browser: a `state` alone is
   * replayable into a victim's session (login CSRF), a state that only verifies
   * against a value held in the victim's own cookie jar is not.
   */
  binding: string
  /** Opaque value echoed by the provider; also carried in the URL. */
  state: string
}

export interface DriveAuthorizationState {
  /** Nonce — makes the state single-use. */
  n: string
  /** Expiry, epoch ms. */
  e: number
  /** Provider name. */
  p: string
  /** SHA-256 of the browser binding. */
  b: string
  /** Tenant the connection will belong to — checked at the callback so a state cannot be replayed into another tenant. */
  t: string
}

export interface StartAuthorizationInput {
  provider: string
  tenantId: string
  redirectUri: string
  scopes?: readonly string[] | undefined
}

export interface CompleteAuthorizationInput {
  provider: string
  tenantId: string
  state: string | undefined
  binding: string | undefined
}

/**
 * Signs, verifies and consumes authorization states, and derives the PKCE
 * verifier.
 *
 * The verifier is **derived** from the binding rather than stored, so the flow
 * keeps no server-side session: there is nothing to garbage-collect, nothing to
 * replicate between instances, and nothing an attacker can read out of a shared
 * store. The binding lives only in the user's cookie.
 */
export class DriveAuthorizationFlow {
  private readonly ttl: number
  private readonly now: () => number
  /** Consumed nonces, remembered until they expire, so a state works exactly once. */
  private readonly consumed = new Map<string, number>()

  constructor(
    private readonly secret: string,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    if (secret.length < 16) {
      throw new DriveAuthorizationInvalidError('the signing secret must be at least 16 characters (use env `secret()`).')
    }
    this.ttl = options.ttlMs ?? DEFAULT_STATE_TTL_MS
    this.now = options.now ?? Date.now
  }

  /** Starts a flow: returns the state to put in the URL and the binding to put in a cookie. */
  start(input: StartAuthorizationInput): { state: string; binding: string; codeChallenge: string } {
    const binding = randomToken()
    const state = this.sign({
      n: randomToken(16),
      e: this.now() + this.ttl,
      p: input.provider,
      b: sha256(binding),
      t: input.tenantId,
    })
    return { state, binding, codeChallenge: challengeFor(this.verifier(binding)) }
  }

  /**
   * Verifies the callback and consumes the state.
   *
   * Every failure produces the same error type and a generic reason: telling a
   * caller *which* check failed is free help for someone probing the flow.
   */
  complete(input: CompleteAuthorizationInput): { codeVerifier: string } {
    const payload = this.verify(input.state)
    if (payload.p !== input.provider) throw new DriveAuthorizationInvalidError('the state does not match this provider.')
    if (payload.t !== input.tenantId) throw new DriveAuthorizationInvalidError('the state does not match this tenant.')
    if (!input.binding || !safeEqual(sha256(input.binding), payload.b)) {
      throw new DriveAuthorizationInvalidError('the request is not the one that started this authorization.')
    }
    this.consume(payload)
    return { codeVerifier: this.verifier(input.binding) }
  }

  /** PKCE verifier, derived from the binding under the app secret. 43 url-safe characters. */
  private verifier(binding: string): string {
    return createHmac('sha256', this.secret).update(`drives:pkce:${binding}`).digest('base64url')
  }

  private sign(payload: DriveAuthorizationState): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`
  }

  private verify(state: string | undefined): DriveAuthorizationState {
    if (!state) throw new DriveAuthorizationInvalidError('no state was returned.')
    const dot = state.indexOf('.')
    if (dot < 0) throw new DriveAuthorizationInvalidError('the state is malformed.')
    const body = state.slice(0, dot)
    const signature = state.slice(dot + 1)
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url')
    if (!safeEqual(signature, expected)) throw new DriveAuthorizationInvalidError('the state signature does not verify.')
    let payload: DriveAuthorizationState
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DriveAuthorizationState
    } catch {
      throw new DriveAuthorizationInvalidError('the state is malformed.')
    }
    if (typeof payload.e !== 'number' || payload.e <= this.now()) {
      throw new DriveAuthorizationInvalidError('the authorization expired; start it again.')
    }
    if (typeof payload.n !== 'string' || typeof payload.b !== 'string' || typeof payload.p !== 'string' || typeof payload.t !== 'string') {
      throw new DriveAuthorizationInvalidError('the state is malformed.')
    }
    return payload
  }

  private consume(payload: DriveAuthorizationState): void {
    const now = this.now()
    for (const [nonce, expiry] of this.consumed) if (expiry <= now) this.consumed.delete(nonce)
    if (this.consumed.has(payload.n)) throw new DriveAuthorizationInvalidError('this authorization was already used.')
    this.consumed.set(payload.n, payload.e)
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url')

/** PKCE S256 challenge for a verifier. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Validates the redirect URI an app hands us.
 *
 * It is a deployment value, not user input — but it ends up in a URL the user's
 * browser follows, so a mistake here is an open redirect with the provider's
 * blessing. Absolute, `https:` (or `http://localhost` for development), and no
 * credentials or fragment.
 */
export function assertRedirectUri(redirectUri: string): void {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch {
    throw new DriveAuthorizationInvalidError(`"${redirectUri}" is not an absolute URL.`)
  }
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    throw new DriveAuthorizationInvalidError('the redirect URI must use https (http is allowed only on localhost).')
  }
  if (url.username !== '' || url.password !== '') {
    throw new DriveAuthorizationInvalidError('the redirect URI must not carry credentials.')
  }
  if (url.hash !== '') throw new DriveAuthorizationInvalidError('the redirect URI must not carry a fragment.')
}
