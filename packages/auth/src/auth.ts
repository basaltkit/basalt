import { randomBytes, randomUUID } from 'node:crypto'
import { MachizeError, parseDuration, type DurationInput, type HookBus } from '@machize/core'
import { ScryptPasswordHasher, type PasswordHasher } from './hashing.js'
import { signJwt, verifyJwt, type JwtClaims } from './jwt.js'
import {
  MemoryRefreshTokenStore,
  MemorySessionStore,
  type AuthUser,
  type PublicUser,
  type RefreshTokenStore,
  type SessionRecord,
  type SessionStore,
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
}

export const publicUser = (user: AuthUser): PublicUser => ({ id: user.id, email: user.email })

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

  /** Credentials → token pair. Emits auth:login / auth:login_failed. */
  async login(email: string, password: string): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const user = await this.attempt(email, password)
    if (!user) {
      await this.hooks?.emit('auth:login_failed', { email })
      throw new InvalidCredentialsError()
    }
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
