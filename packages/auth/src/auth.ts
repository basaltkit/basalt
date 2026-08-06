import { randomBytes, randomUUID } from 'node:crypto'
import { MachizeError, parseDuration, type DurationInput, type HookBus } from '@machize/core'
import { ScryptPasswordHasher, type PasswordHasher } from './hashing.js'
import { LoginThrottle } from './throttle.js'
import { signJwt, verifyJwt, type JwtClaims } from './jwt.js'
import {
  MemoryAuthTokenStore,
  MemoryRefreshTokenStore,
  MemorySessionStore,
  type AuthTokenPurpose,
  type AuthTokenStore,
  type AuthUser,
  type PublicUser,
  type RefreshTokenStore,
  type SessionRecord,
  type SessionStore,
  type UserPatch,
  type UserSource,
} from './stores.js'

export class InvalidCredentialsError extends MachizeError {
  readonly status = 401
  constructor() {
    super('AUTH_INVALID_CREDENTIALS', 'Invalid email or password.')
  }
}

export class EmailTakenError extends MachizeError {
  readonly status = 409
  constructor() {
    super('AUTH_EMAIL_TAKEN', 'An account with this email already exists.')
  }
}

export class RefreshInvalidError extends MachizeError {
  readonly status = 401
  constructor() {
    super('AUTH_REFRESH_INVALID', 'The refresh token is invalid or expired.')
  }
}

/** A used refresh token came back — the whole family is revoked. */
export class RefreshReusedError extends MachizeError {
  readonly status = 401
  constructor() {
    super('AUTH_REFRESH_REUSED', 'Refresh token reuse detected. All sessions of this family were revoked.')
  }
}

export class AuthRequiredError extends MachizeError {
  readonly status = 401
  constructor() {
    super('AUTH_REQUIRED', 'Authentication required.')
  }
}

/** A verification / reset token was unknown, already used, or expired. */
export class AuthTokenInvalidError extends MachizeError {
  readonly status = 400
  constructor() {
    super('AUTH_TOKEN_INVALID', 'The link is invalid or has expired. Request a new one.')
  }
}

/** The configured UserSource can't be updated (needed for verification/reset). */
export class UserUpdateUnsupportedError extends MachizeError {
  readonly status = 500
  constructor() {
    super('AUTH_UPDATE_UNSUPPORTED', 'The UserSource does not implement update() — required for this flow.')
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
    if (!user) return null
    return (await this.hasher.verify(password, user.passwordHash)) ? user : null
  }

  /**
   * Credentials → token pair. Emits auth:login / auth:login_failed. Locks the
   * account after too many failures (see {@link LoginThrottle}); a success
   * clears the counter.
   */
  async login(email: string, password: string): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const key = email.toLowerCase()
    this.throttle?.assertAllowed(key)

    const user = await this.attempt(email, password)
    if (!user) {
      this.throttle?.recordFailure(key)
      await this.hooks?.emit('auth:login_failed', { email })
      throw new InvalidCredentialsError()
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
    await this.refreshTokens.revokeAllForUser?.(user.id)
    await this.hooks?.emit('auth:password_reset', { user: publicUser(user) })
    return publicUser(user)
  }

  // --- token helpers -------------------------------------------------------

  private async issueOneTimeToken(userId: string, purpose: AuthTokenPurpose, ttl: DurationInput): Promise<string> {
    await this.tokens.deleteForUser(userId, purpose) // one live token per purpose
    const token = randomBytes(32).toString('base64url')
    await this.tokens.create({ token, userId, purpose, expiresAt: Date.now() + parseDuration(ttl) })
    return token
  }

  private async consumeToken(token: string, purpose: AuthTokenPurpose) {
    const record = await this.tokens.find(token)
    if (!record || record.purpose !== purpose || record.usedAt !== undefined || Date.now() >= record.expiresAt) {
      throw new AuthTokenInvalidError()
    }
    await this.tokens.markUsed(token)
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
