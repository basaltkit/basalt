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
  /**
   * The message quotes the provider's reply (`error_description`, an HTTP
   * status, a discovery URL): diagnostic for the log, not for the client, who
   * only gets the code and a neutral message.
   */
  readonly expose = false
  constructor(detail: string) {
    super('AUTH_OAUTH_EXCHANGE_FAILED', `OAuth token/profile exchange failed: ${detail}`)
  }
}

/** Thrown when the OAuth provider configuration is unsafe (see {@link OAuthProvider.allowedEmailDomains}). */
export class OAuthProviderConfigError extends BasaltError {
  readonly status = 500
  constructor(detail: string) {
    super('AUTH_OAUTH_PROVIDER_CONFIG', `Unsafe OAuth configuration: ${detail}.`)
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
  /**
   * Expected `iss` of the `id_token` (OpenID Connect). When set, an `id_token`
   * issued by anyone else is refused.
   */
  issuer?: string | string[]
  /**
   * Email domains this provider is trusted to assert (exact, case-insensitive
   * match on the part after `@`; list subdomains explicitly). A login for any
   * other domain is refused with `AUTH_OAUTH_EXCHANGE_FAILED` before any account
   * is looked up.
   */
  allowedEmailDomains?: string[]
  /**
   * Explicit opt-out of {@link allowedEmailDomains} for an {@link enterprise}
   * provider when several providers are configured: this IdP may assert **any**
   * email. Only for an IdP you fully control.
   */
  allowAnyEmailDomain?: true
  /**
   * The provider is an enterprise IdP administered by someone else — typically a
   * customer's Okta / Entra / Keycloak ({@link oidcProvider} sets it). Its admin
   * decides which emails it asserts as verified, so when more than one provider
   * is configured it must declare {@link allowedEmailDomains} (or
   * {@link allowAnyEmailDomain}) or the {@link OAuth} service refuses to start.
   */
  enterprise?: boolean
}

interface ProviderKeys {
  clientId: string
  clientSecret: string
  scopes?: string[]
}

/** Default deadline for a request to a provider, ms. */
const DEFAULT_TIMEOUT_MS = 10_000

/** A provider claim that must be a non-empty string; otherwise the login fails closed. */
function claim(value: unknown, what: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new OAuthExchangeError(`provider returned no ${what}`)
}

/** Parses a provider response body as JSON, turning an HTML/garbage reply into an exchange error. */
async function readJson<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T
  } catch {
    throw new OAuthExchangeError(`${what} did not return JSON`)
  }
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
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    async fetchProfile(accessToken, doFetch) {
      const res = await doFetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new OAuthExchangeError(`google userinfo HTTP ${res.status}`)
      const p = await readJson<{ sub?: unknown; email?: unknown; email_verified?: boolean; name?: string }>(res, 'google userinfo')
      return {
        subject: claim(p.sub, 'subject'),
        email: claim(p.email, 'email'),
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
      const user = await readJson<{ id?: unknown; login?: string; name?: string; email?: string | null }>(userRes, 'github user')
      const subject = claim(user.id, 'subject')

      // GitHub often hides the email on /user; the primary verified one comes from /user/emails.
      let email = user.email ?? undefined
      let emailVerified = false
      const emailsRes = await doFetch('https://api.github.com/user/emails', { headers })
      if (emailsRes.ok) {
        const emails = await readJson<{ email: string; primary: boolean; verified: boolean }[]>(emailsRes, 'github emails')
        const list = Array.isArray(emails) ? emails : []
        const primary = list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified)
        if (primary) {
          email = primary.email
          emailVerified = true
        }
      }
      if (typeof email !== 'string' || !email) throw new OAuthExchangeError('github returned no usable email')
      return { subject, email, emailVerified, ...(user.name ? { name: user.name } : {}) }
    },
  }
}

interface OidcConfig extends ProviderKeys {
  /** Display name for this provider. Default: 'oidc'. */
  name?: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  /** The IdP issuer; when set, the `id_token`'s `iss` must match it. */
  issuer?: string
  /** See {@link OAuthProvider.allowedEmailDomains}. */
  allowedEmailDomains?: string[]
  /** See {@link OAuthProvider.allowAnyEmailDomain}. */
  allowAnyEmailDomain?: true
}

/**
 * A generic **OIDC** provider — enterprise SSO for any OpenID Connect IdP
 * (Okta, Azure AD / Entra ID, Auth0, Google Workspace, Keycloak…). Pass the
 * three endpoints from the IdP's `.well-known/openid-configuration`, or use
 * {@link discoverOidcProvider} to fetch them for you. Maps the standard OIDC
 * `userinfo` claims (`sub`, `email`, `email_verified`, `name`).
 *
 * The IdP's admin decides which emails it asserts as verified: restrict each
 * customer's IdP to that customer's domains with `allowedEmailDomains` —
 * required as soon as more than one provider is configured (see
 * {@link OAuthProvider.enterprise}).
 */
export function oidcProvider(config: OidcConfig): OAuthProvider {
  return {
    name: config.name ?? 'oidc',
    authorizeUrl: config.authorizeUrl,
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: config.scopes ?? ['openid', 'email', 'profile'],
    enterprise: true,
    ...(config.issuer !== undefined ? { issuer: config.issuer } : {}),
    ...(config.allowedEmailDomains !== undefined ? { allowedEmailDomains: config.allowedEmailDomains } : {}),
    ...(config.allowAnyEmailDomain === true ? { allowAnyEmailDomain: true as const } : {}),
    async fetchProfile(accessToken, doFetch) {
      const res = await doFetch(config.userInfoUrl, { headers: { authorization: `Bearer ${accessToken}` } })
      if (!res.ok) throw new OAuthExchangeError(`oidc userinfo HTTP ${res.status}`)
      const p = await readJson<{ sub?: unknown; email?: unknown; email_verified?: boolean; name?: string }>(res, 'oidc userinfo')
      return {
        subject: claim(p.sub, 'subject'),
        email: claim(p.email, 'email'),
        emailVerified: p.email_verified === true,
        ...(p.name ? { name: p.name } : {}),
      }
    },
  }
}

/** `https:` — or plain `http:` to a loopback host (a local IdP in development). */
function isSecureEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/**
 * Builds an {@link oidcProvider} by fetching the IdP's OIDC discovery document
 * (`${issuer}/.well-known/openid-configuration`). Await it at startup.
 *
 * Per OpenID Connect Discovery §4.3 the document's `issuer` must equal the
 * configured one (trailing slashes aside), and every endpoint must be `https:`
 * (plain `http:` only to a loopback host), or discovery fails.
 */
export async function discoverOidcProvider(config: {
  name?: string
  /** The IdP issuer URL, e.g. `https://acme.okta.com` or `https://login.microsoftonline.com/<tenant>/v2.0`. */
  issuer: string
  clientId: string
  clientSecret: string
  scopes?: string[]
  /** See {@link OAuthProvider.allowedEmailDomains}. */
  allowedEmailDomains?: string[]
  /** See {@link OAuthProvider.allowAnyEmailDomain}. */
  allowAnyEmailDomain?: true
  fetch?: typeof fetch
  /** Timeout for the discovery request, ms. Default 10 s. */
  timeoutMs?: number
}): Promise<OAuthProvider> {
  const doFetch = config.fetch ?? globalThis.fetch
  const url = `${stripTrailingSlashes(config.issuer)}/.well-known/openid-configuration`
  let res: Response
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS) })
  } catch {
    throw new OAuthExchangeError(`OIDC discovery request failed for ${url}`)
  }
  if (!res.ok) throw new OAuthExchangeError(`OIDC discovery HTTP ${res.status} for ${url}`)
  const meta = await readJson<{
    issuer?: unknown
    authorization_endpoint?: unknown
    token_endpoint?: unknown
    userinfo_endpoint?: unknown
  }>(res, 'OIDC discovery')
  if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.userinfo_endpoint) {
    throw new OAuthExchangeError('OIDC discovery document is missing required endpoints')
  }
  if (typeof meta.issuer !== 'string' || stripTrailingSlashes(meta.issuer) !== stripTrailingSlashes(config.issuer)) {
    throw new OAuthExchangeError(`OIDC discovery document is for another issuer (${String(meta.issuer)})`)
  }
  if (
    !isSecureEndpoint(meta.authorization_endpoint) ||
    !isSecureEndpoint(meta.token_endpoint) ||
    !isSecureEndpoint(meta.userinfo_endpoint)
  ) {
    throw new OAuthExchangeError('OIDC discovery document lists a non-https endpoint')
  }
  return oidcProvider({
    ...(config.name ? { name: config.name } : {}),
    authorizeUrl: meta.authorization_endpoint,
    tokenUrl: meta.token_endpoint,
    userInfoUrl: meta.userinfo_endpoint,
    issuer: meta.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(config.scopes ? { scopes: config.scopes } : {}),
    ...(config.allowedEmailDomains !== undefined ? { allowedEmailDomains: config.allowedEmailDomains } : {}),
    ...(config.allowAnyEmailDomain === true ? { allowAnyEmailDomain: true as const } : {}),
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
  /**
   * Timeout for every request to a provider (token endpoint, userinfo, …), ms.
   * Default 10 s; a provider that hangs fails the login with
   * `AUTH_OAUTH_EXCHANGE_FAILED` instead of holding the request open.
   */
  timeoutMs?: number
  /**
   * An account already linked to one subject of a provider, and a login from a
   * **different** subject of that provider asserting the same email: `'refuse'`
   * (default, `AUTH_ACCOUNT_LINK_CONFLICT`) or `'link'` the new subject too.
   * Choose `'link'` only for an IdP that re-issues subjects (a directory
   * migration) — otherwise it lets a second IdP account take the first one's
   * place by email.
   */
  subjectConflict?: 'refuse' | 'link'
}

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

function normalizeAllowedDomains(p: OAuthProvider): Set<string> | undefined {
  if (p.allowedEmailDomains === undefined) return undefined
  if (!Array.isArray(p.allowedEmailDomains) || p.allowedEmailDomains.length === 0) {
    throw new OAuthProviderConfigError(`provider "${p.name}" has an empty allowedEmailDomains list`)
  }
  const out = new Set<string>()
  for (const d of p.allowedEmailDomains) {
    const n = typeof d === 'string' ? d.toLowerCase() : ''
    if (!DOMAIN_RE.test(n)) {
      throw new OAuthProviderConfigError(`provider "${p.name}" has an invalid allowedEmailDomains entry ${JSON.stringify(d)}`)
    }
    out.add(n)
  }
  return out
}

/** The domain of a single-`@`, whitespace/control-free email, lowercased; otherwise `undefined`. */
function emailDomain(email: string): string | undefined {
  if (/[\s\p{Cc}\p{Cf}]/u.test(email)) return undefined
  const at = email.indexOf('@')
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return undefined
  return email.slice(at + 1).toLowerCase()
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
  private readonly allowedDomains = new Map<string, Set<string>>()
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private readonly stateTtl: number

  constructor(
    private readonly auth: Auth,
    providers: OAuthProvider[],
    private readonly options: OAuthOptions,
  ) {
    const seen = new Set<string>()
    for (const p of providers) {
      // A duplicate name would silently pair one entry's IdP with another's allowlist.
      if (seen.has(p.name)) throw new OAuthProviderConfigError(`provider "${p.name}" is configured more than once`)
      seen.add(p.name)
      const domains = normalizeAllowedDomains(p)
      if (domains) this.allowedDomains.set(p.name, domains)
      else if (p.enterprise === true && providers.length > 1 && p.allowAnyEmailDomain !== true) {
        throw new OAuthProviderConfigError(
          `provider "${p.name}" is an enterprise IdP with no allowedEmailDomains; with several providers each ` +
            "customer's IdP must be restricted to its own email domains (or set allowAnyEmailDomain: true for an IdP you fully control)",
        )
      }
    }
    this.providers = new Map(providers.map((p) => [p.name, p]))
    const base = options.fetch ?? globalThis.fetch
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Every provider call gets a deadline unless the caller passed its own signal.
    this.doFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      base(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeout) })) as typeof fetch
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
    if (p.scopes.includes('openid')) {
      // OIDC Core §3.1.3.3: the token response of an `openid` flow carries an id_token.
      if (idToken === undefined) throw new OAuthExchangeError('the token response has no id_token')
      this.checkIdToken(p, idToken, this.derive('nonce', input.binding))
    }
    let profile: OAuthProfile
    try {
      profile = await p.fetchProfile(accessToken, this.doFetch)
    } catch (err) {
      if (err instanceof BasaltError) throw err
      throw new OAuthExchangeError(`${name} profile request failed`)
    }
    const email = typeof profile.email === 'string' ? profile.email : ''
    const domain = emailDomain(email)
    if (!domain) throw new OAuthExchangeError('provider returned no usable email')
    const allowed = this.allowedDomains.get(p.name)
    if (allowed && !allowed.has(domain)) {
      throw new OAuthExchangeError(`provider "${p.name}" is not trusted for the email domain "${domain}"`)
    }
    // The provider's stable subject decides which account this is once linked;
    // the email only matters for the first login (see Auth.socialLogin).
    const subject = typeof profile.subject === 'string' ? profile.subject : ''
    if (!subject) throw new OAuthExchangeError('provider returned no subject')
    return this.auth.socialLogin(email, {
      emailVerified: profile.emailVerified === true,
      identity: { provider: p.name, subject },
      ...(this.options.mfa ? { mfa: this.options.mfa } : {}),
      ...(this.options.subjectConflict ? { subjectConflict: this.options.subjectConflict } : {}),
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

  /**
   * The id_token is received directly from the token endpoint over TLS, so its
   * signature is not re-verified (OIDC Core §3.1.3.7 item 6), but its claims
   * must still be for THIS flow: our nonce, our client as audience, not
   * expired, and — when the provider declares one — the expected issuer.
   */
  private checkIdToken(p: OAuthProvider, idToken: string, expectedNonce: string): void {
    let claims: { nonce?: unknown; aud?: unknown; exp?: unknown; iss?: unknown }
    try {
      claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as typeof claims
    } catch {
      throw new OAuthExchangeError('malformed id_token')
    }
    if (claims === null || typeof claims !== 'object') throw new OAuthExchangeError('malformed id_token')
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expectedNonce)) {
      throw new OAuthExchangeError('id_token nonce mismatch')
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(p.clientId)) throw new OAuthExchangeError('id_token audience mismatch')
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.now()) {
      throw new OAuthExchangeError('id_token expired')
    }
    if (p.issuer !== undefined) {
      const issuers = Array.isArray(p.issuer) ? p.issuer : [p.issuer]
      if (typeof claims.iss !== 'string' || !issuers.some((i) => stripTrailingSlashes(i) === stripTrailingSlashes(claims.iss as string))) {
        throw new OAuthExchangeError('id_token issuer mismatch')
      }
    }
  }

  private async exchangeCode(
    p: OAuthProvider,
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<{ accessToken: string; idToken?: string }> {
    let res: Response
    try {
      res = await this.doFetch(p.tokenUrl, {
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
    } catch {
      throw new OAuthExchangeError(`${p.name} token endpoint request failed`)
    }
    const text = await res.text()
    let json: { access_token?: unknown; id_token?: unknown; error_description?: unknown; error?: unknown } = {}
    try {
      json = text ? (JSON.parse(text) as typeof json) : {}
    } catch {
      throw new OAuthExchangeError(`token endpoint HTTP ${res.status} did not return JSON`)
    }
    if (json === null || typeof json !== 'object') json = {}
    if (!res.ok || typeof json.access_token !== 'string' || !json.access_token) {
      const reason = typeof json.error_description === 'string' ? json.error_description : typeof json.error === 'string' ? json.error : undefined
      throw new OAuthExchangeError(reason ?? `token endpoint HTTP ${res.status}`)
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
