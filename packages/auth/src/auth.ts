import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { BasaltError, parseDuration, type DurationInput, type HookBus } from '@basaltkit/core'
import { ScryptPasswordHasher, type PasswordHasher } from './hashing.js'
import { LoginThrottle } from './throttle.js'
import { signJwt, verifyJwt, type JwtClaims } from './jwt.js'
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js'
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

export interface AuthOptions {
  users: UserSource
  secret: string
  hasher?: PasswordHasher
  sessions?: SessionStore
  refreshTokens?: RefreshTokenStore
  accessTtl?: DurationInput
  refreshTtl?: DurationInput
  sessionTtl?: DurationInput
  hooks?: HookBus
  /** Brute-force lockout. Enabled by default; pass `false` to disable. */
  loginThrottle?: LoginThrottle | false
  /** Store for verification/reset tokens. Default: in-memory. */
  tokens?: AuthTokenStore
  /** Email-verification link lifetime. Default 24h. */
  verificationTtl?: DurationInput
  /** Password-reset link lifetime. Default 1h. */
  resetTtl?: DurationInput
  /** Store for MFA (TOTP) enrollment state. Default: in-memory. */
  mfa?: MfaStore
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
  private readonly hooks: HookBus | undefined
  private readonly throttle: LoginThrottle | undefined
  private readonly tokens: AuthTokenStore
  private readonly verificationTtl: DurationInput
  private readonly resetTtl: DurationInput
  private readonly mfa: MfaStore
  private readonly mfaIssuer: string

  constructor(options: AuthOptions) {
    this.users = options.users
    this.secret = options.secret
    this.hasher = options.hasher ?? new ScryptPasswordHasher()
    this.sessions = options.sessions ?? new MemorySessionStore()
    this.refreshTokens = options.refreshTokens ?? new MemoryRefreshTokenStore()
    this.accessTtl = options.accessTtl ?? '15m'
    this.refreshTtl = options.refreshTtl ?? '30d'
    this.sessionTtl = options.sessionTtl ?? '30d'
    this.hooks = options.hooks
    this.throttle = options.loginThrottle === false ? undefined : options.loginThrottle ?? new LoginThrottle()
    this.tokens = options.tokens ?? new MemoryAuthTokenStore()
    this.verificationTtl = options.verificationTtl ?? '24h'
    this.resetTtl = options.resetTtl ?? '1h'
    this.mfa = options.mfa ?? new MemoryMfaStore()
    this.mfaIssuer = options.mfaIssuer ?? 'Basalt'
  }

  async register(email: string, password: string): Promise<PublicUser> {
    if (await this.users.findByEmail(email)) throw new EmailTakenError()
    const user = await this.users.create({
      email,
      passwordHash: await this.hasher.hash(password),
    })
    await this.hooks?.emit('auth:registered', { user: publicUser(user) })
    return publicUser(user)
  }

  /** Verifies credentials without side effects. Null on failure. */
  async attempt(email: string, password: string): Promise<AuthUser | null> {
    const user = await this.users.findByEmail(email)
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
  ): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const key = email.toLowerCase()
    this.throttle?.assertAllowed(key)

    const user = await this.attempt(email, password)
    if (!user) {
      this.throttle?.recordFailure(key)
      await this.hooks?.emit('auth:login_failed', { email })
      throw new InvalidCredentialsError()
    }

    if (await this.isMfaEnabled(user.id)) {
      if (!mfaCode) throw new MfaRequiredError() // password was correct — not a failure
      if (!(await this.verifyMfaCode(user.id, mfaCode))) {
        this.throttle?.recordFailure(key)
        throw new MfaInvalidCodeError()
      }
    }

    this.throttle?.reset(key)
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
    const record = await this.refreshTokens.find(refreshToken)
    if (!record) throw new RefreshInvalidError()
    if (record.usedAt !== undefined) {
      await this.refreshTokens.revokeFamily(record.familyId)
      throw new RefreshReusedError()
    }
    if (Date.now() >= record.expiresAt) throw new RefreshInvalidError()

    await this.refreshTokens.markUsed(refreshToken)
    return this.issueTokens(record.userId, record.familyId)
  }

  /** Revokes a refresh family — logout for token-based clients. */
  async revoke(refreshToken: string): Promise<void> {
    const record = await this.refreshTokens.find(refreshToken)
    if (record) await this.refreshTokens.revokeFamily(record.familyId)
  }

  verifyAccess(accessToken: string): JwtClaims {
    return verifyJwt(accessToken, this.secret)
  }

  async createSession(userId: string): Promise<SessionRecord> {
    return this.sessions.create(userId, parseDuration(this.sessionTtl))
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
    const user = await this.users.findByEmail(email)
    if (!user) return null
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

  // --- password reset ------------------------------------------------------

  /**
   * Starts a password reset: mints a single-use token and emits
   * `auth:password_reset_requested`. Returns null when no account matches, so
   * the caller always responds 200 (no account enumeration).
   */
  async requestPasswordReset(email: string): Promise<{ user: PublicUser; token: string } | null> {
    const user = await this.users.findByEmail(email)
    if (!user) return null
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
  async enrollMfa(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.users.findById(userId)
    if (!user) throw new AuthRequiredError()
    const secret = generateTotpSecret()
    await this.mfa.set(userId, { secret, enabled: false, recoveryCodes: [] })
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
    if (!verifyTotp(record.secret, code)) throw new MfaInvalidCodeError()

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
    if (verifyTotp(record.secret, code)) return true

    const hash = this.hashRecoveryCode(code)
    const index = record.recoveryCodes.indexOf(hash)
    if (index === -1) return false
    record.recoveryCodes.splice(index, 1) // consume it
    await this.mfa.set(userId, record)
    return true
  }

  private generateRecoveryCode(): string {
    const raw = randomBytes(5).toString('hex') // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`
  }

  private hashRecoveryCode(code: string): string {
    return createHash('sha256').update(code.replace(/-/g, '').toLowerCase()).digest('hex')
  }

  // --- token helpers -------------------------------------------------------

  /** SHA-256 of a one-time token — only this is persisted, never the raw value. */
  private hashOneTimeToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private async issueOneTimeToken(userId: string, purpose: AuthTokenPurpose, ttl: DurationInput): Promise<string> {
    await this.tokens.deleteForUser(userId, purpose) // one live token per purpose
    const token = randomBytes(32).toString('base64url')
    // Store only the hash: a leak of the token table can't be replayed to reset
    // or verify accounts (the raw token lives only in the user's inbox/link).
    await this.tokens.create({
      token: this.hashOneTimeToken(token),
      userId,
      purpose,
      expiresAt: Date.now() + parseDuration(ttl),
    })
    return token
  }

  private async consumeToken(token: string, purpose: AuthTokenPurpose) {
    const hashed = this.hashOneTimeToken(token)
    const record = await this.tokens.find(hashed)
    if (!record || record.purpose !== purpose || record.usedAt !== undefined || Date.now() >= record.expiresAt) {
      throw new AuthTokenInvalidError()
    }
    await this.tokens.markUsed(hashed)
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
      token: refreshToken,
      familyId,
      userId,
      expiresAt: Date.now() + parseDuration(this.refreshTtl),
    })
    return {
      accessToken: signJwt({ sub: userId }, { secret: this.secret, expiresIn: this.accessTtl }),
      refreshToken,
    }
  }
}
