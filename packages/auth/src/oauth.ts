import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type { Auth, TokenPair } from './auth.js'
import type { PublicUser } from './stores.js'

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

export interface OAuthOptions {
  /** Secret used to sign the CSRF `state` (typically your APP_SECRET). */
  secret: string
  /** Injected fetch (tests). Default: global fetch. */
  fetch?: typeof fetch
  /** Clock in ms (tests). Default: Date.now. */
  now?: () => number
  /** How long a signed `state` stays valid, in ms. Default: 10 minutes. */
  stateTtlMs?: number
}

interface StatePayload {
  n: string
  e: number
  p: string
}

/**
 * OAuth 2.0 authorization-code login. Server-side (confidential-client) flow:
 * build an authorize URL with a signed, expiring `state`, then exchange the code
 * for a token, fetch the profile, and log the user in via {@link Auth.socialLogin}.
 * The `state` is HMAC-signed and stateless — no server storage, works cookieless.
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

  /** The provider's authorization URL to redirect the browser to. */
  authorizeUrl(name: string, redirectUri: string): string {
    const p = this.provider(name)
    const state = this.signState({ n: randomBytes(16).toString('hex'), e: this.now() + this.stateTtl, p: name })
    const params = new URLSearchParams({
      client_id: p.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: p.scopes.join(' '),
      state,
    })
    return `${p.authorizeUrl}?${params.toString()}`
  }

  /** Verifies `state`, exchanges the code, fetches the profile, and logs in. */
  async callback(
    name: string,
    input: { code: string; state: string | undefined; redirectUri: string },
  ): Promise<{ user: PublicUser; tokens: TokenPair; created: boolean }> {
    const payload = this.verifyState(input.state)
    if (payload.p !== name) throw new OAuthStateInvalidError()
    const p = this.provider(name)
    const accessToken = await this.exchangeCode(p, input.code, input.redirectUri)
    const profile = await p.fetchProfile(accessToken, this.doFetch)
    if (!profile.email) throw new OAuthExchangeError('provider returned no email')
    return this.auth.socialLogin(profile.email, { emailVerified: profile.emailVerified === true })
  }

  private async exchangeCode(p: OAuthProvider, code: string, redirectUri: string): Promise<string> {
    const res = await this.doFetch(p.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: p.clientId,
        client_secret: p.clientSecret,
      }).toString(),
    })
    const text = await res.text()
    const json = text ? (JSON.parse(text) as { access_token?: string; error_description?: string; error?: string }) : {}
    if (!res.ok || !json.access_token) {
      throw new OAuthExchangeError(json.error_description ?? json.error ?? `token endpoint HTTP ${res.status}`)
    }
    return json.access_token
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
