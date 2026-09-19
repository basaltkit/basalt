import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type { Auth, TokenPair } from './auth.js'
import type { PublicUser } from './stores.js'

/** Strip trailing '/' without a backtracking regex (avoids ReDoS on long runs). */
export function stripTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

export class OAuthProviderUnknownError extends BasaltError {
  readonly status = 404
  constructor(name: string) {
    super('AUTH_OAUTH_UNKNOWN_PROVIDER', `Unknown OAuth provider "${name}".`)
  }
}

export class OAuthStateInvalidError extends BasaltError {
  readonly status = 400
  constructor() {
    super('AUTH_OAUTH_STATE_INVALID', 'The OAuth state is missing, invalid, tampered with, or expired.')
  }
}

export class OAuthExchangeError extends BasaltError {
  readonly status = 502
  constructor(detail: string) {
    super('AUTH_OAUTH_EXCHANGE_FAILED', `OAuth token/profile exchange failed: ${detail}`)
  }
}

/** The normalized profile a provider returns after a successful login. */
export interface OAuthProfile {
  /** Stable id at the provider (the `sub` / user id). */
  subject: string
  email: string
  emailVerified?: boolean
  name?: string
}

export interface OAuthProvider {
  name: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  scopes: string[]
  /** Fetches and normalizes the user profile from an access token. */
  fetchProfile(accessToken: string, doFetch: typeof fetch): Promise<OAuthProfile>
}

interface ProviderKeys {
  clientId: string
  clientSecret: string
  scopes?: string[]
}

/** Google (OpenID Connect). Default scopes: `openid email profile`. */
export function googleProvider(keys: ProviderKeys): OAuthProvider {
  return {
    name: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: keys.clientId,
    clientSecret: keys.clientSecret,
    scopes: keys.scopes ?? ['openid', 'email', 'profile'],
    async fetchProfile(accessToken, doFetch) {
      const res = await doFetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new OAuthExchangeError(`google userinfo HTTP ${res.status}`)
      const p = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string }
      return {
        subject: String(p.sub),
        email: String(p.email),
        emailVerified: p.email_verified === true,
        ...(p.name ? { name: p.name } : {}),
      }
    },
  }
}

/** GitHub. Default scopes: `read:user user:email` (needed for a verified email). */
export function githubProvider(keys: ProviderKeys): OAuthProvider {
  return {
    name: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientId: keys.clientId,
    clientSecret: keys.clientSecret,
    scopes: keys.scopes ?? ['read:user', 'user:email'],
    async fetchProfile(accessToken, doFetch) {
      const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' }
      const userRes = await doFetch('https://api.github.com/user', { headers })
      if (!userRes.ok) throw new OAuthExchangeError(`github user HTTP ${userRes.status}`)
      const user = (await userRes.json()) as { id?: number; login?: string; name?: string; email?: string | null }

      // GitHub often hides the email on /user; the primary verified one comes from /user/emails.
      let email = user.email ?? undefined
      let emailVerified = false
      const emailsRes = await doFetch('https://api.github.com/user/emails', { headers })
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[]
        const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
        if (primary) {
          email = primary.email
          emailVerified = true
        }
      }
      if (!email) throw new OAuthExchangeError('github returned no usable email')
      return { subject: String(user.id), email, emailVerified, ...(user.name ? { name: user.name } : {}) }
    },
  }
}

interface OidcConfig extends ProviderKeys {
  /** Display name for this provider. Default: 'oidc'. */
  name?: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
}

/**
 * A generic **OIDC** provider — enterprise SSO for any OpenID Connect IdP
 * (Okta, Azure AD / Entra ID, Auth0, Google Workspace, Keycloak…). Pass the
 * three endpoints from the IdP's `.well-known/openid-configuration`, or use
 * {@link discoverOidcProvider} to fetch them for you. Maps the standard OIDC
 * `userinfo` claims (`sub`, `email`, `email_verified`, `name`).
 */
export function oidcProvider(config: OidcConfig): OAuthProvider {
  return {
    name: config.name ?? 'oidc',
    authorizeUrl: config.authorizeUrl,
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: config.scopes ?? ['openid', 'email', 'profile'],
    async fetchProfile(accessToken, doFetch) {
      const res = await doFetch(config.userInfoUrl, { headers: { authorization: `Bearer ${accessToken}` } })
      if (!res.ok) throw new OAuthExchangeError(`oidc userinfo HTTP ${res.status}`)
      const p = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string }
      return {
        subject: String(p.sub),
        email: String(p.email),
        emailVerified: p.email_verified === true,
        ...(p.name ? { name: p.name } : {}),
      }
    },
  }
}

/**
 * Builds an {@link oidcProvider} by fetching the IdP's OIDC discovery document
 * (`${issuer}/.well-known/openid-configuration`). Await it at startup.
 */
export async function discoverOidcProvider(config: {
  name?: string
  /** The IdP issuer URL, e.g. `https://acme.okta.com` or `https://login.microsoftonline.com/<tenant>/v2.0`. */
  issuer: string
  clientId: string
  clientSecret: string
  scopes?: string[]
  fetch?: typeof fetch
}): Promise<OAuthProvider> {
  const doFetch = config.fetch ?? globalThis.fetch
  const url = `${stripTrailingSlashes(config.issuer)}/.well-known/openid-configuration`
  const res = await doFetch(url)
  if (!res.ok) throw new OAuthExchangeError(`OIDC discovery HTTP ${res.status} for ${url}`)
  const meta = (await res.json()) as {
    authorization_endpoint?: string
    token_endpoint?: string
    userinfo_endpoint?: string
  }
  if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.userinfo_endpoint) {
    throw new OAuthExchangeError('OIDC discovery document is missing required endpoints')
  }
  return oidcProvider({
    ...(config.name ? { name: config.name } : {}),
    authorizeUrl: meta.authorization_endpoint,
    tokenUrl: meta.token_endpoint,
    userInfoUrl: meta.userinfo_endpoint,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(config.scopes ? { scopes: config.scopes } : {}),
  })
}

export interface OAuthOptions {
  /** Secret used to sign the CSRF `state` (typically your APP_SECRET). */
  secret: string
  /** Injected fetch (tests). Default: global fetch. */
  fetch?: typeof fetch
  /** Clock in ms (tests). Default: Date.now. */
  now?: () => number
  /** How long a signed `state` stays valid, in ms. Default: 10 minutes. */
  stateTtlMs?: number
  /**
   * MFA for an existing account that has it enabled. `'required'` (default)
   * refuses the social login with `AUTH_MFA_REQUIRED` — the callback cannot
   * collect a code. `'skip'` trusts the provider's own second factor; choose it
   * only for an IdP that enforces MFA.
   */
  mfa?: 'required' | 'skip'
}

interface StatePayload {
  /** Random nonce — single-use. */
  n: string
  /** Expiry (ms). */
  e: number
  /** Provider name. */
  p: string
  /** SHA-256 of the browser binding (the value in the HttpOnly cookie). */
  b: string
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url')
const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
/** Cap on remembered (consumed) states; each lives only until its expiry. */
const MAX_CONSUMED_STATES = 100_000

/**
 * OAuth 2.0 authorization-code login. Server-side (confidential-client) flow:
 * build an authorize URL with a signed, expiring `state`, then exchange the code
 * for a token, fetch the profile, and log the user in via {@link Auth.socialLogin}.
 *
 * The flow is bound to the browser that started it: {@link authorize} returns a
 * random `binding` the caller stores in an HttpOnly cookie ({@link oauthRoutes}
 * does). The signed `state` carries its hash, the PKCE verifier (S256) and the
 * OIDC nonce are derived from it, and the callback requires it back — so an
 * attacker's callback URL opened in a victim's browser (login CSRF) or an
 * injected authorization code is refused. Each `state` is single-use.
 */
export class OAuth {
  private readonly providers: Map<string, OAuthProvider>
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private readonly stateTtl: number

  constructor(
    private readonly auth: Auth,
    providers: OAuthProvider[],
    private readonly options: OAuthOptions,
  ) {
    this.providers = new Map(providers.map((p) => [p.name, p]))
    this.doFetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.stateTtl = options.stateTtlMs ?? 10 * 60_000
  }

  names(): string[] {
    return [...this.providers.keys()]
  }

  private provider(name: string): OAuthProvider {
    const p = this.providers.get(name)
    if (!p) throw new OAuthProviderUnknownError(name)
    return p
  }

  /**
   * Starts a login: returns the provider's authorization URL to redirect the
   * browser to, and the `binding` to keep in an HttpOnly cookie until the
   * callback (pass it back to {@link callback}).
   */
  authorize(name: string, redirectUri: string): { url: string; binding: string } {
    const binding = randomBytes(32).toString('base64url')
    return { url: this.authorizeUrl(name, redirectUri, binding), binding }
  }

  /**
   * The provider's authorization URL for a caller-managed `binding` (at least
   * 32 characters of randomness, stored where only the initiating browser can
   * present it). Prefer {@link authorize}, which generates one.
   */
  authorizeUrl(name: string, redirectUri: string, binding: string): string {
    if (typeof binding !== 'string' || binding.length < 32) throw new OAuthStateInvalidError()
    const p = this.provider(name)
    const state = this.signState({
      n: randomBytes(16).toString('hex'),
      e: this.now() + this.stateTtl,
      p: name,
      b: sha256(binding),
    })
    const params = new URLSearchParams({
      client_id: p.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: p.scopes.join(' '),
      state,
      code_challenge: sha256(this.derive('pkce', binding)),
      code_challenge_method: 'S256',
    })
    if (p.scopes.includes('openid')) params.set('nonce', this.derive('nonce', binding))
    return `${p.authorizeUrl}?${params.toString()}`
  }

  /**
   * Verifies `state` against the browser `binding`, consumes it (single-use),
   * exchanges the code with the PKCE verifier, fetches the profile, and logs in.
   */
  async callback(
    name: string,
    input: { code: string; state: string | undefined; redirectUri: string; binding: string | undefined },
  ): Promise<{ user: PublicUser; tokens: TokenPair; created: boolean }> {
    const payload = this.verifyState(input.state)
    if (payload.p !== name) throw new OAuthStateInvalidError()
    if (!input.binding || typeof payload.b !== 'string' || !safeEqual(sha256(input.binding), payload.b)) {
      throw new OAuthStateInvalidError()
    }
    this.consumeState(payload)
    const p = this.provider(name)
    const { accessToken, idToken } = await this.exchangeCode(p, input.code, input.redirectUri, this.derive('pkce', input.binding))
    if (p.scopes.includes('openid') && idToken !== undefined) this.checkNonce(idToken, this.derive('nonce', input.binding))
    const profile = await p.fetchProfile(accessToken, this.doFetch)
    if (!profile.email) throw new OAuthExchangeError('provider returned no email')
    return this.auth.socialLogin(profile.email, {
      emailVerified: profile.emailVerified === true,
      ...(this.options.mfa ? { mfa: this.options.mfa } : {}),
    })
  }

  /** A per-flow secret derived from the binding (PKCE verifier, OIDC nonce): 43 url-safe chars. */
  private derive(label: 'pkce' | 'nonce', binding: string): string {
    return createHmac('sha256', this.options.secret).update(`oauth:${label}:${binding}`).digest('base64url')
  }

  /** Single-use: a state nonce is remembered until it expires. */
  private readonly consumed = new Map<string, number>()
  private consumeState(payload: StatePayload): void {
    const now = this.now()
    if (this.consumed.size >= MAX_CONSUMED_STATES) {
      for (const [n, exp] of this.consumed) if (now > exp) this.consumed.delete(n)
      for (const n of this.consumed.keys()) {
        if (this.consumed.size < MAX_CONSUMED_STATES) break
        this.consumed.delete(n)
      }
    }
    if (this.consumed.has(payload.n)) throw new OAuthStateInvalidError()
    this.consumed.set(payload.n, payload.e)
  }

  /** The id_token (received directly from the token endpoint over TLS) must echo our nonce. */
  private checkNonce(idToken: string, expected: string): void {
    let claims: { nonce?: unknown }
    try {
      claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { nonce?: unknown }
    } catch {
      throw new OAuthExchangeError('malformed id_token')
    }
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expected)) {
      throw new OAuthExchangeError('id_token nonce mismatch')
    }
  }

  private async exchangeCode(
    p: OAuthProvider,
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<{ accessToken: string; idToken?: string }> {
    const res = await this.doFetch(p.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: p.clientId,
        client_secret: p.clientSecret,
        code_verifier: codeVerifier,
      }).toString(),
    })
    const text = await res.text()
    const json = text
      ? (JSON.parse(text) as { access_token?: string; id_token?: string; error_description?: string; error?: string })
      : {}
    if (!res.ok || !json.access_token) {
      throw new OAuthExchangeError(json.error_description ?? json.error ?? `token endpoint HTTP ${res.status}`)
    }
    return { accessToken: json.access_token, ...(typeof json.id_token === 'string' ? { idToken: json.id_token } : {}) }
  }

  private signState(payload: StatePayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createHmac('sha256', this.options.secret).update(body).digest('base64url')
    return `${body}.${sig}`
  }

  private verifyState(state: string | undefined): StatePayload {
    if (!state) throw new OAuthStateInvalidError()
    const dot = state.indexOf('.')
    if (dot < 0) throw new OAuthStateInvalidError()
    const body = state.slice(0, dot)
    const sig = state.slice(dot + 1)
    const expected = createHmac('sha256', this.options.secret).update(body).digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthStateInvalidError()
    let payload: StatePayload
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload
    } catch {
      throw new OAuthStateInvalidError()
    }
    if (typeof payload.e !== 'number' || this.now() > payload.e) throw new OAuthStateInvalidError()
    return payload
  }
}
