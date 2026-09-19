import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { BasaltError, parseDuration, type DurationInput, type HookBus } from '@basaltkit/core'
import { ScryptPasswordHasher, type PasswordHasher } from './hashing.js'
import { LoginThrottle } from './throttle.js'
import { signJwt, verifyJwt, type JwtClaims } from './jwt.js'
import { generateTotpSecret, matchTotpStep, otpauthUri } from './totp.js'
import { decryptSecret, deriveKey, encryptSecret } from './secret-box.js'
import {
  MemoryAuthTokenStore,
  MemoryMfaStore,
  MemoryRefreshTokenStore,
  MemorySessionStore,
  type AuthTokenPurpose,
  type AuthTokenStore,
  type AuthUser,
  type MfaStore,
  type PublicUser,
  type RefreshTokenStore,
  type SessionRecord,
  type SessionStore,
  type TokenVersionStore,
  type UserPatch,
  type UserSource,
} from './stores.js'

export class InvalidCredentialsError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_INVALID_CREDENTIALS', 'Invalid email or password.')
  }
}

export class EmailTakenError extends BasaltError {
  readonly status = 409
  constructor() {
    super('AUTH_EMAIL_TAKEN', 'An account with this email already exists.')
  }
}

/**
 * Thrown at construction when the JWT signing secret is missing or too weak. A
 * short/low-entropy HS256 key can be brute-forced offline, letting an attacker
 * forge access tokens for any account — so this fails closed rather than boot
 * with a guessable key. Use `@basaltkit/env`'s `secret({ minLength: 32 })`.
 */
export class WeakJwtSecretError extends BasaltError {
  constructor(reason: string) {
    super('AUTH_WEAK_SECRET', `The auth signing secret is ${reason}. Set a strong APP_SECRET (>= 32 chars).`)
  }
}

export class RefreshInvalidError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REFRESH_INVALID', 'The refresh token is invalid or expired.')
  }
}

/** A used refresh token came back — the whole family is revoked. */
export class RefreshReusedError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REFRESH_REUSED', 'Refresh token reuse detected. All sessions of this family were revoked.')
  }
}

export class AuthRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REQUIRED', 'Authentication required.')
  }
}

/** A verification / reset token was unknown, already used, or expired. */
export class AuthTokenInvalidError extends BasaltError {
  readonly status = 400
  constructor() {
    super('AUTH_TOKEN_INVALID', 'The link is invalid or has expired. Request a new one.')
  }
}

/** The configured UserSource can't be updated (needed for verification/reset). */
export class UserUpdateUnsupportedError extends BasaltError {
  readonly status = 500
  constructor() {
    super('AUTH_UPDATE_UNSUPPORTED', 'The UserSource does not implement update() — required for this flow.')
  }
}

/** Credentials were correct but the account has MFA — a code is required. */
export class MfaRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_MFA_REQUIRED', 'A multi-factor authentication code is required.')
  }
}

/** The supplied MFA (or recovery) code was wrong. */
export class MfaInvalidCodeError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_MFA_INVALID', 'The authentication code is incorrect.')
  }
}

/** MFA is already active: re-enrolling would silently switch it off. Disable it (with a code) first. */
export class MfaAlreadyEnabledError extends BasaltError {
  readonly status = 409
  constructor() {
    super('AUTH_MFA_ALREADY_ENABLED', 'MFA is already enabled. Disable it with a valid code before enrolling again.')
  }
}

/**
 * A social / SSO login matched an existing account by email, but the provider
 * did not vouch for that email (unverified), so linking would let anyone who
 * can create an IdP account with the address take the account over.
 */
export class SocialLinkRefusedError extends BasaltError {
  readonly status = 403
  constructor() {
    super(
      'AUTH_SOCIAL_LINK_REFUSED',
      'An account with this email already exists and the identity provider did not verify the email. Sign in with your password instead.',
    )
  }
}

/**
 * Canonical form of an email identity: trimmed and lowercased. Every lookup,
 * create and throttle key goes through it, so `Bob@acme.test` and
 * `bob@acme.test` are one account.
 */
export const canonicalEmail = (email: string): string => email.trim().toLowerCase()

/** An MFA action needed an enrollment that doesn't exist. */
export class MfaNotEnrolledError extends BasaltError {
  readonly status = 400
  constructor() {
    super('AUTH_MFA_NOT_ENROLLED', 'No MFA enrollment is in progress for this account.')
  }
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export interface SessionCookieOptions {
  /** Cookie name. Default: `basalt_session`. */
  name?: string
  /** Cookie path. Default: `/`. */
  path?: string
  /** Whether the browser may expose the cookie to JavaScript. Default: true. */
  httpOnly?: boolean
  /** SameSite policy. Default: `Lax`. */
  sameSite?: 'Strict' | 'Lax' | 'None'
  /** Whether to require HTTPS. Defaults to production-only. */
  secure?: boolean
}

export interface AuthOptions {
  users: UserSource
  secret: string
  hasher?: PasswordHasher
  sessions?: SessionStore
  refreshTokens?: RefreshTokenStore
  accessTtl?: DurationInput
  refreshTtl?: DurationInput
  sessionTtl?: DurationInput
  sessionCookie?: SessionCookieOptions
  hooks?: HookBus
  /** Brute-force lockout (per email). Enabled by default; pass `false` to disable. */
  loginThrottle?: LoginThrottle | false
  /**
   * Per-IP login throttle — blunts password spraying (1 attempt across many
   * accounts) and lockout-DoS that a per-email counter alone misses. Enabled by
   * default with a higher budget than the per-email one; pass `false` to disable.
   * Only applies when the caller passes the client ip to `login`.
   */
  ipLoginThrottle?: LoginThrottle | false
  /**
   * Per-account throttle on password-reset and email-verification requests.
   * Over budget, a request is silently dropped (no new token, no hook, the live
   * link keeps working) — so the endpoints cannot be used to mail-bomb a user or
   * keep invalidating their reset link. Default: 3 per 15 minutes per account
   * and purpose; pass `false` to disable.
   */
  emailRequestThrottle?: LoginThrottle | false
  /**
   * Make the public registration endpoint enumeration-safe: a request for an
   * email that already exists returns the same response (and does equivalent
   * work) as a fresh signup, instead of a 409 that reveals the account exists.
   * Applies to {@link Auth.registerSafely} (used by the register route); the
   * lower-level {@link Auth.register} always throws on a duplicate. Default true.
   */
  enumerationSafeRegister?: boolean
  /** Store for verification/reset tokens. Default: in-memory. */
  tokens?: AuthTokenStore
  /** Email-verification link lifetime. Default 24h. */
  verificationTtl?: DurationInput
  /** Password-reset link lifetime. Default 1h. */
  resetTtl?: DurationInput
  /** Store for MFA (TOTP) enrollment state. Default: in-memory. */
  mfa?: MfaStore
  /**
   * Enables access-token revocation. When set, access tokens carry a version
   * (`tv`) and `resetPassword`/`revokeAllTokens` bump it — invalidating every
   * token issued before the bump, even before its TTL expires. Opt-in; access
   * verification then costs one store read per request. Default: off.
   */
  tokenVersions?: TokenVersionStore
  /**
   * Key for encrypting TOTP secrets at rest (AES-256-GCM). When set, secrets are
   * stored as `v1:` envelopes so a database leak can't recover a live second
   * factor; existing plaintext records keep working and are encrypted on next
   * write. Any length — derived to 32 bytes. Omit to store secrets in plaintext.
   */
  mfaEncryptionKey?: string | Buffer
  /** Issuer name shown in authenticator apps. Default 'Basalt'. */
  mfaIssuer?: string
}

export const publicUser = (user: AuthUser): PublicUser => ({
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerified ?? false,
})

export class Auth {
  readonly users: UserSource
  private readonly hasher: PasswordHasher
  private readonly sessions: SessionStore
  private readonly refreshTokens: RefreshTokenStore
  private readonly secret: string
  private readonly accessTtl: DurationInput
  private readonly refreshTtl: DurationInput
  private readonly sessionTtl: DurationInput
  private readonly sessionCookie: Required<SessionCookieOptions>
  private readonly hooks: HookBus | undefined
  private readonly throttle: LoginThrottle | undefined
  private readonly ipThrottle: LoginThrottle | undefined
  private readonly requestThrottle: LoginThrottle | undefined
  private readonly tokens: AuthTokenStore
  private readonly verificationTtl: DurationInput
  private readonly resetTtl: DurationInput
  private readonly mfa: MfaStore
  private readonly mfaIssuer: string
  private readonly mfaKey: Buffer | undefined
  private readonly tokenVersions: TokenVersionStore | undefined
  private readonly enumerationSafeRegister: boolean

  constructor(options: AuthOptions) {
    this.users = options.users
    this.secret = options.secret
    // Fail closed on a weak signing key. Always reject an empty secret; in
    // production require >= 32 chars (a short HS256 key is offline-forgeable).
    if (!this.secret) throw new WeakJwtSecretError('missing')
    if (process.env['NODE_ENV'] === 'production' && this.secret.length < 32) {
      throw new WeakJwtSecretError('too short')
    }
    this.hasher = options.hasher ?? new ScryptPasswordHasher()
    this.sessions = options.sessions ?? new MemorySessionStore()
    this.refreshTokens = options.refreshTokens ?? new MemoryRefreshTokenStore()
    this.accessTtl = options.accessTtl ?? '15m'
    this.refreshTtl = options.refreshTtl ?? '30d'
    this.sessionTtl = options.sessionTtl ?? '30d'
    this.sessionCookie = {
      name: options.sessionCookie?.name ?? 'basalt_session',
      path: options.sessionCookie?.path ?? '/',
      httpOnly: options.sessionCookie?.httpOnly ?? true,
      sameSite: options.sessionCookie?.sameSite ?? 'Lax',
      secure: options.sessionCookie?.secure ?? process.env['NODE_ENV'] === 'production',
    }
    this.hooks = options.hooks
    this.throttle = options.loginThrottle === false ? undefined : options.loginThrottle ?? new LoginThrottle()
    this.ipThrottle =
      options.ipLoginThrottle === false
        ? undefined
        : options.ipLoginThrottle ?? new LoginThrottle({ maxAttempts: 50, windowMs: 15 * 60_000 })
    this.requestThrottle =
      options.emailRequestThrottle === false
        ? undefined
        : options.emailRequestThrottle ?? new LoginThrottle({ maxAttempts: 3, windowMs: 15 * 60_000 })
    this.tokens = options.tokens ?? new MemoryAuthTokenStore()
    this.verificationTtl = options.verificationTtl ?? '24h'
    this.resetTtl = options.resetTtl ?? '1h'
    this.mfa = options.mfa ?? new MemoryMfaStore()
    this.mfaIssuer = options.mfaIssuer ?? 'Basalt'
    this.mfaKey = options.mfaEncryptionKey ? deriveKey(options.mfaEncryptionKey) : undefined
    this.tokenVersions = options.tokenVersions
    this.enumerationSafeRegister = options.enumerationSafeRegister ?? true
  }

  async register(rawEmail: string, password: string): Promise<PublicUser> {
    const email = canonicalEmail(rawEmail)
    if (await this.users.findByEmail(email)) throw new EmailTakenError()
    const user = await this.users.create({
      email,
      passwordHash: await this.hasher.hash(password),
    })
    await this.hooks?.emit('auth:registered', { user: publicUser(user) })
    return publicUser(user)
  }

  /**
   * Logs in an externally-authenticated user (e.g. from an OAuth provider),
   * matched by email — find-or-create. A new account is created **passwordless**
   * (a random, unusable password hash), so password login won't work for it
   * until a password is set. A provider-verified email flips `emailVerified`.
   * Returns the tokens and whether the account was just created.
   *
   * Linking to an EXISTING account is refused ({@link SocialLinkRefusedError})
   * unless `emailVerified` is `true` — an unverified provider email proves
   * nothing about who owns the address. When the existing account had never
   * verified its email, whoever registered it first is not trusted either: its
   * password, sessions, refresh tokens and MFA are revoked before it is adopted
   * (`auth:social_account_adopted`). An account with MFA enabled requires
   * `mfaCode` ({@link MfaRequiredError}) unless `mfa: 'skip'` is passed
   * explicitly (only for an IdP that enforces its own second factor).
   */
  async socialLogin(
    rawEmail: string,
    options: { emailVerified?: boolean; mfaCode?: string; mfa?: 'required' | 'skip' } = {},
  ): Promise<{ user: PublicUser; tokens: TokenPair; created: boolean }> {
    const email = canonicalEmail(rawEmail)
    let user = await this.users.findByEmail(email)
    let created = false
    if (!user) {
      user = await this.users.create({
        email,
        passwordHash: await this.hasher.hash(randomBytes(32).toString('hex')),
      })
      created = true
      await this.hooks?.emit('auth:registered', { user: publicUser(user) })
      if (options.emailVerified === true && this.users.update) {
        user = (await this.users.update(user.id, { emailVerified: true })) ?? user
      }
    } else {
      if (options.emailVerified !== true) throw new SocialLinkRefusedError()
      if (!user.emailVerified) {
        user = await this.adoptUnverifiedAccount(user)
      } else if (options.mfa !== 'skip' && (await this.isMfaEnabled(user.id))) {
        if (!options.mfaCode) throw new MfaRequiredError()
        const key = user.email
        this.throttle?.reserve(key)
        if (!(await this.verifyMfaCode(user.id, options.mfaCode))) {
          await this.hooks?.emit('auth:mfa_failed', { userId: user.id })
          throw new MfaInvalidCodeError()
        }
        this.throttle?.reset(key)
      }
    }
    const tokens = await this.issueTokens(user.id)
    await this.hooks?.emit('auth:login', { user: publicUser(user) })
    return { user: publicUser(user), tokens, created }
  }

  /**
   * A provider-verified login is taking over an account whose email was never
   * verified: whoever registered it could be anyone (pre-account hijacking), so
   * every credential they may hold is revoked before the verified owner gets in.
   */
  private async adoptUnverifiedAccount(user: AuthUser): Promise<AuthUser> {
    if (!this.users.update) throw new SocialLinkRefusedError()
    const adopted =
      (await this.users.update(user.id, {
        passwordHash: await this.hasher.hash(randomBytes(32).toString('hex')),
        emailVerified: true,
      })) ?? user
    await this.refreshTokens.revokeAllForUser?.(user.id)
    await this.sessions.deleteAllForUser?.(user.id)
    await this.tokenVersions?.increment(user.id)
    await this.mfa.delete(user.id)
    await this.hooks?.emit('auth:social_account_adopted', { user: publicUser(adopted) })
    return adopted
  }

  /**
   * Enumeration-safe registration for the public endpoint: creates the account
   * for a new email, or — when the email is already taken — does equivalent work
   * (so timing doesn't leak) and emits `auth:register_existing_email` so the app
   * can send an out-of-band "you already have an account" email. Returns nothing
   * either way, so the response can't reveal whether the account existed.
   *
   * With `enumerationSafeRegister: false` it throws {@link EmailTakenError} on a
   * duplicate instead (the classic, enumerable behavior).
   */
  async registerSafely(rawEmail: string, password: string): Promise<void> {
    const email = canonicalEmail(rawEmail)
    const existing = await this.users.findByEmail(email)
    if (existing) {
      if (!this.enumerationSafeRegister) throw new EmailTakenError()
      // Equalize timing with the create path (which hashes), then signal the
      // collision out-of-band — never in the HTTP response.
      await this.hasher.hash(password)
      await this.hooks?.emit('auth:register_existing_email', { email })
      return
    }
    const user = await this.users.create({
      email,
      passwordHash: await this.hasher.hash(password),
    })
    await this.hooks?.emit('auth:registered', { user: publicUser(user) })
  }

  /** Verifies credentials without side effects. Null on failure. */
  async attempt(email: string, password: string): Promise<AuthUser | null> {
    const user = await this.users.findByEmail(canonicalEmail(email))
    if (!user) {
      // Equalize timing: a missing account must cost the same as a wrong
      // password, or the response time reveals which emails are registered
      // (account enumeration). Verify against a throwaway hash and discard.
      await this.hasher.verify(password, await this.dummyHash())
      return null
    }
    return (await this.hasher.verify(password, user.passwordHash)) ? user : null
  }

  private dummyHashPromise?: Promise<string>
  /** A valid hash of a throwaway secret, produced once by the configured hasher. */
  private dummyHash(): Promise<string> {
    return (this.dummyHashPromise ??= this.hasher.hash('basalt-timing-equalizer'))
  }

  /**
   * Credentials → token pair. Emits auth:login / auth:login_failed. Locks the
   * account after too many failures (see {@link LoginThrottle}); a success
   * clears the counter.
   *
   * When the account has MFA enabled, `mfaCode` (a TOTP or recovery code) is
   * required: a correct password with a missing code throws
   * {@link MfaRequiredError} (without counting as a failed attempt), and a
   * wrong code throws {@link MfaInvalidCodeError}.
   */
  async login(
    email: string,
    password: string,
    mfaCode?: string,
    context: { ip?: string } = {},
  ): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const key = canonicalEmail(email)
    const ipKey = context.ip ? `ip:${context.ip}` : undefined
    // Reserve the attempt BEFORE the (async) verification: the counter moves
    // synchronously, so a parallel burst cannot run more password or MFA
    // guesses than the budget allows. Success gives the reservation back.
    try {
      this.throttle?.reserve(key)
    } catch (error) {
      await this.hooks?.emit('auth:locked_out', { email: key })
      throw error
    }
    if (ipKey && this.ipThrottle) {
      try {
        this.ipThrottle.reserve(ipKey)
      } catch (error) {
        this.throttle?.release(key)
        await this.hooks?.emit('auth:locked_out', { email: key, ip: context.ip as string })
        throw error
      }
    }
    const release = () => {
      this.throttle?.release(key)
      if (ipKey) this.ipThrottle?.release(ipKey)
    }

    const user = await this.attempt(key, password)
    if (!user) {
      await this.hooks?.emit('auth:login_failed', { email: key })
      throw new InvalidCredentialsError()
    }

    if (await this.isMfaEnabled(user.id)) {
      if (!mfaCode) {
        release() // password was correct — not a failure
        throw new MfaRequiredError()
      }
      if (!(await this.verifyMfaCode(user.id, mfaCode))) {
        await this.hooks?.emit('auth:mfa_failed', { userId: user.id })
        throw new MfaInvalidCodeError()
      }
    }

    this.throttle?.reset(key)
    if (ipKey) this.ipThrottle?.release(ipKey)
    const tokens = await this.issueTokens(user.id)
    await this.hooks?.emit('auth:login', { user: publicUser(user) })
    return { user: publicUser(user), tokens }
  }

  /**
   * Refresh rotation with reuse detection: every refresh consumes the token
   * and issues a new one in the same family. If a consumed token comes back
   * (theft indicator), the whole family is revoked.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const hashed = this.hashToken(refreshToken)
    const record = await this.refreshTokens.find(hashed)
    if (!record) throw new RefreshInvalidError()
    if (record.usedAt !== undefined) return this.reuseDetected(record.userId, record.familyId)
    if (Date.now() >= record.expiresAt) throw new RefreshInvalidError()
    // A deleted account must not keep minting tokens from a leftover refresh token.
    if (!(await this.users.findById(record.userId))) {
      await this.refreshTokens.revokeFamily(record.familyId)
      throw new RefreshInvalidError()
    }

    // Compare-and-swap: `false` means another caller consumed this exact token
    // between our read and this write — the very race reuse detection exists for.
    if ((await this.refreshTokens.markUsed(hashed)) === false) {
      return this.reuseDetected(record.userId, record.familyId)
    }
    const pair = await this.issueTokens(record.userId, record.familyId)
    // The consumed token is the witness that the family is still alive:
    // revokeFamily/revokeAllForUser delete every row of it. If a concurrent
    // revocation (a reuse loser, a logout, a logout-everywhere) ran between our
    // CAS and the insert above, the row is gone — revoke again so the token we
    // just stored does not outlive its family, and refuse.
    if (!(await this.refreshTokens.find(hashed))) {
      await this.refreshTokens.revokeFamily(record.familyId)
      throw new RefreshReusedError()
    }
    return pair
  }

  private async reuseDetected(userId: string, familyId: string): Promise<never> {
    await this.refreshTokens.revokeFamily(familyId)
    await this.hooks?.emit('auth:refresh_reused', { userId, familyId })
    throw new RefreshReusedError()
  }

  /** Revokes a refresh family — logout for token-based clients. */
  async revoke(refreshToken: string): Promise<void> {
    const record = await this.refreshTokens.find(this.hashToken(refreshToken))
    if (record) await this.refreshTokens.revokeFamily(record.familyId)
  }

  /** Structural JWT verification only (signature + expiry). */
  verifyAccess(accessToken: string): JwtClaims {
    return verifyJwt(accessToken, this.secret)
  }

  /**
   * Verifies the access token AND, when token-version revocation is enabled,
   * rejects a token minted before the user's version was last bumped (i.e.
   * revoked by a password reset / `revokeAllTokens`). Prefer this over
   * {@link verifyAccess} on the request path.
   */
  async verifyAccessToken(accessToken: string): Promise<JwtClaims> {
    const claims = this.verifyAccess(accessToken)
    if (this.tokenVersions) {
      const current = await this.tokenVersions.get(claims.sub)
      if ((claims.tv ?? 0) < current) throw new AuthTokenInvalidError()
    }
    return claims
  }

  /**
   * Revokes every access token issued so far for the user (logout-everywhere),
   * revoking every refresh token and server-side session (when the stores
   * implement `revokeAllForUser` / `deleteAllForUser`, as the bundled ones do)
   * and bumping the token version so outstanding access tokens die too (needs a
   * {@link TokenVersionStore}; without one, access tokens live until their TTL).
   */
  async revokeAllTokens(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllForUser?.(userId)
    await this.sessions.deleteAllForUser?.(userId)
    await this.tokenVersions?.increment(userId)
  }

  async createSession(userId: string): Promise<SessionRecord> {
    return this.sessions.create(userId, parseDuration(this.sessionTtl))
  }

  sessionCookieHeader(sessionId: string): string {
    const ttlMs = parseDuration(this.sessionTtl)
    const cookie = this.sessionCookie
    const expires = new Date(Date.now() + ttlMs).toUTCString()
    return `${cookie.name}=${encodeURIComponent(sessionId)}; Path=${cookie.path};${cookie.httpOnly ? ' HttpOnly;' : ''} SameSite=${cookie.sameSite}; Max-Age=${Math.max(1, Math.floor(ttlMs / 1000))}; Expires=${expires}${cookie.secure ? '; Secure' : ''}`
  }

  sessionIdFromCookie(cookieHeader?: string): string | null {
    if (!cookieHeader) return null
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === this.sessionCookie.name && rest.length > 0) {
        return decodeURIComponent(rest.join('='))
      }
    }
    return null
  }

  expiredSessionCookieHeader(): string {
    const cookie = this.sessionCookie
    return `${cookie.name}=; Path=${cookie.path};${cookie.httpOnly ? ' HttpOnly;' : ''} SameSite=${cookie.sameSite}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${cookie.secure ? '; Secure' : ''}`
  }

  async sessionUser(sessionId: string): Promise<AuthUser | null> {
    const session = await this.sessions.find(sessionId)
    return session ? this.users.findById(session.userId) : null
  }

  async logout(sessionId: string): Promise<void> {
    const session = await this.sessions.find(sessionId)
    await this.sessions.delete(sessionId)
    if (session) {
      const user = await this.users.findById(session.userId)
      if (user) await this.hooks?.emit('auth:logout', { user: publicUser(user) })
    }
  }

  // --- email verification --------------------------------------------------

  /**
   * Starts email verification: mints a single-use token and emits
   * `auth:verify_requested` for the app to email. Returns the token (so a
   * caller can build the link) or null if no account matches — never reveals
   * whether the email exists.
   */
  async requestEmailVerification(email: string): Promise<{ user: PublicUser; token: string } | null> {
    const user = await this.users.findByEmail(canonicalEmail(email))
    if (!user || !this.allowEmailRequest('verify_email', user.id)) return null
    const token = await this.issueOneTimeToken(user.id, 'verify_email', this.verificationTtl)
    await this.hooks?.emit('auth:verify_requested', { user: publicUser(user), token })
    return { user: publicUser(user), token }
  }

  /** Consumes a verification token and marks the user's email verified. */
  async verifyEmail(token: string): Promise<PublicUser> {
    const record = await this.consumeToken(token, 'verify_email')
    const user = await this.updateUser(record.userId, { emailVerified: true })
    await this.hooks?.emit('auth:email_verified', { user: publicUser(user) })
    return publicUser(user)
  }

  /** Per-account budget for reset/verification mails; false = drop silently. */
  private allowEmailRequest(purpose: AuthTokenPurpose, userId: string): boolean {
    if (!this.requestThrottle) return true
    try {
      this.requestThrottle.reserve(`${purpose}:${userId}`)
      return true
    } catch {
      return false
    }
  }

  // --- password reset ------------------------------------------------------

  /**
   * Starts a password reset: mints a single-use token and emits
   * `auth:password_reset_requested`. Returns null when no account matches (or
   * the per-account request budget is spent — the live link then stays valid),
   * so the caller always responds 200 (no account enumeration).
   */
  async requestPasswordReset(email: string): Promise<{ user: PublicUser; token: string } | null> {
    const user = await this.users.findByEmail(canonicalEmail(email))
    if (!user || !this.allowEmailRequest('reset_password', user.id)) return null
    const token = await this.issueOneTimeToken(user.id, 'reset_password', this.resetTtl)
    await this.hooks?.emit('auth:password_reset_requested', { user: publicUser(user), token })
    return { user: publicUser(user), token }
  }

  /**
   * Consumes a reset token, sets the new password, and revokes every existing
   * session/refresh token for the user (a reset logs everyone else out).
   */
  async resetPassword(token: string, newPassword: string): Promise<PublicUser> {
    const record = await this.consumeToken(token, 'reset_password')
    const user = await this.updateUser(record.userId, {
      passwordHash: await this.hasher.hash(newPassword),
    })
    // A reset must lock out anyone already in — both token-based clients and
    // active server-side sessions (cookie logins survived this before).
    await this.refreshTokens.revokeAllForUser?.(user.id)
    await this.sessions.deleteAllForUser?.(user.id)
    // Bump the token version so outstanding access tokens are rejected before
    // their TTL expires (no-op unless a TokenVersionStore is configured).
    await this.tokenVersions?.increment(user.id)
    await this.hooks?.emit('auth:password_reset', { user: publicUser(user) })
    return publicUser(user)
  }

  // --- MFA (TOTP) ----------------------------------------------------------

  async isMfaEnabled(userId: string): Promise<boolean> {
    return (await this.mfa.get(userId))?.enabled ?? false
  }

  async mfaStatus(userId: string): Promise<{ enabled: boolean; pending: boolean }> {
    const record = await this.mfa.get(userId)
    return { enabled: record?.enabled ?? false, pending: record !== null && !record.enabled }
  }

  /**
   * Begins MFA enrollment: generates a fresh secret (not yet active) and
   * returns it plus an `otpauth://` URI to render as a QR code. Call
   * {@link activateMfa} with a code from the app to switch it on.
   */
  /** Encrypt a TOTP secret for storage (no-op when no key is configured). */
  private encryptMfaSecret(secret: string): string {
    return this.mfaKey ? encryptSecret(secret, this.mfaKey) : secret
  }

  /** Decrypt a stored TOTP secret (passes plaintext/legacy values through). */
  private decryptMfaSecret(stored: string): string {
    return this.mfaKey ? decryptSecret(stored, this.mfaKey) : stored
  }

  async enrollMfa(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.users.findById(userId)
    if (!user) throw new AuthRequiredError()
    // Overwriting an active record would switch MFA off without a code —
    // exactly what disableMfa() refuses to do.
    if ((await this.mfa.get(userId))?.enabled) throw new MfaAlreadyEnabledError()
    const secret = generateTotpSecret()
    await this.mfa.set(userId, { secret: this.encryptMfaSecret(secret), enabled: false, recoveryCodes: [] })
    return {
      secret,
      otpauthUri: otpauthUri({ secret, account: user.email, issuer: this.mfaIssuer }),
    }
  }

  /**
   * Confirms enrollment by checking a code against the pending secret, enables
   * MFA, and returns freshly generated single-use recovery codes (shown once).
   */
  async activateMfa(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const record = await this.mfa.get(userId)
    if (!record || record.enabled) throw new MfaNotEnrolledError()
    const step = matchTotpStep(this.decryptMfaSecret(record.secret), code)
    if (step === null) throw new MfaInvalidCodeError()

    const recoveryCodes = Array.from({ length: 10 }, () => this.generateRecoveryCode())
    await this.mfa.set(userId, {
      secret: record.secret,
      enabled: true,
      recoveryCodes: recoveryCodes.map((c) => this.hashRecoveryCode(c)),
    })
    const user = await this.users.findById(userId)
    if (user) await this.hooks?.emit('auth:mfa_enabled', { user: publicUser(user) })
    return { recoveryCodes }
  }

  /** Turns MFA off. Requires a valid current code (or recovery code). */
  async disableMfa(userId: string, code: string): Promise<void> {
    if (!(await this.isMfaEnabled(userId))) throw new MfaNotEnrolledError()
    if (!(await this.verifyMfaCode(userId, code))) throw new MfaInvalidCodeError()
    await this.mfa.delete(userId)
    const user = await this.users.findById(userId)
    if (user) await this.hooks?.emit('auth:mfa_disabled', { user: publicUser(user) })
  }

  /**
   * Verifies a TOTP code or, failing that, a single-use recovery code (which
   * is consumed on success). Returns false unless MFA is enabled.
   */
  async verifyMfaCode(userId: string, code: string): Promise<boolean> {
    const record = await this.mfa.get(userId)
    if (!record || !record.enabled) return false
    const step = matchTotpStep(this.decryptMfaSecret(record.secret), code)
    if (step !== null) {
      // Anti-replay: a code from a step already used cannot be reused within
      // its ~90s window (an intercepted code is single-use).
      if (record.lastUsedStep !== undefined && step <= record.lastUsedStep) return false
      // Atomic consume when the store supports it: two parallel requests with
      // the same code must not both pass the read-then-write above.
      if (this.mfa.consumeTotpStep) return this.mfa.consumeTotpStep(userId, step)
      record.lastUsedStep = step
      await this.mfa.set(userId, record)
      return true
    }

    const hash = this.hashRecoveryCode(code)
    const index = record.recoveryCodes.indexOf(hash)
    if (index === -1) return false
    if (this.mfa.consumeRecoveryCode) return this.mfa.consumeRecoveryCode(userId, hash)
    record.recoveryCodes.splice(index, 1) // consume it
    await this.mfa.set(userId, record)
    return true
  }

  private generateRecoveryCode(): string {
    // 80 bits of entropy (was 40): a leaked recovery-code hash can't be brute
    // forced offline even with a fast/unsalted digest. 20 hex chars, grouped.
    const raw = randomBytes(10).toString('hex')
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`
  }

  private hashRecoveryCode(code: string): string {
    return createHash('sha256').update(code.replace(/-/g, '').toLowerCase()).digest('hex')
  }

  // --- token helpers -------------------------------------------------------

  /** SHA-256 of a bearer secret (one-time token, refresh token) — only this is
   * persisted, so a leak of the token/session table can't be replayed. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private async issueOneTimeToken(userId: string, purpose: AuthTokenPurpose, ttl: DurationInput): Promise<string> {
    await this.tokens.deleteForUser(userId, purpose) // one live token per purpose
    const token = randomBytes(32).toString('base64url')
    // Store only the hash: a leak of the token table can't be replayed to reset
    // or verify accounts (the raw token lives only in the user's inbox/link).
    await this.tokens.create({
      token: this.hashToken(token),
      userId,
      purpose,
      expiresAt: Date.now() + parseDuration(ttl),
    })
    return token
  }

  private async consumeToken(token: string, purpose: AuthTokenPurpose) {
    const hashed = this.hashToken(token)
    const record = await this.tokens.find(hashed)
    if (!record || record.purpose !== purpose || record.usedAt !== undefined || Date.now() >= record.expiresAt) {
      throw new AuthTokenInvalidError()
    }
    // Compare-and-swap: a concurrent consumer of this single-use token wins, and
    // this call is rejected as if the token had already been spent.
    if ((await this.tokens.markUsed(hashed)) === false) throw new AuthTokenInvalidError()
    return record
  }

  private async updateUser(id: string, patch: UserPatch): Promise<AuthUser> {
    if (!this.users.update) throw new UserUpdateUnsupportedError()
    const user = await this.users.update(id, patch)
    if (!user) throw new AuthTokenInvalidError() // user vanished between issue and consume
    return user
  }

  private async issueTokens(userId: string, familyId: string = randomUUID()): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url')
    await this.refreshTokens.create({
      // Persist only the hash; the raw token is returned to the client below.
      token: this.hashToken(refreshToken),
      familyId,
      userId,
      expiresAt: Date.now() + parseDuration(this.refreshTtl),
    })
    const tv = this.tokenVersions ? await this.tokenVersions.get(userId) : undefined
    return {
      accessToken: signJwt(
        { sub: userId, ...(tv !== undefined ? { tv } : {}) },
        { secret: this.secret, expiresIn: this.accessTtl },
      ),
      refreshToken,
    }
  }
}
