import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** SHA-256 of a session id — only this is persisted, never the raw cookie value. */
const hashSessionId = (id: string): string => createHash('sha256').update(id).digest('hex')

/** The stored user record. Apps map this onto their own user table. */
export interface AuthUser {
  id: string
  email: string
  passwordHash: string
  emailVerified?: boolean
  [key: string]: unknown
}

/** What lands in ctx().user — never carries the password hash. */
export interface PublicUser {
  id: string
  email: string
  emailVerified?: boolean
}

/** Fields the email-verification / password-reset flows update on a user. */
export type UserPatch = Partial<Pick<AuthUser, 'passwordHash' | 'emailVerified'>>

export interface UserSource {
  findByEmail(email: string): Promise<AuthUser | null>
  findById(id: string): Promise<AuthUser | null>
  create(data: { email: string; passwordHash: string }): Promise<AuthUser>
  /** Required for email verification and password reset. Returns the updated user. */
  update?(id: string, patch: UserPatch): Promise<AuthUser | null>
}

export class MemoryUserSource implements UserSource {
  private readonly users = new Map<string, AuthUser>()

  async findByEmail(email: string): Promise<AuthUser | null> {
    for (const user of this.users.values()) {
      if (user.email === email) return user
    }
    return null
  }

  async findById(id: string): Promise<AuthUser | null> {
    return this.users.get(id) ?? null
  }

  async create(data: { email: string; passwordHash: string }): Promise<AuthUser> {
    const user: AuthUser = { id: randomUUID(), emailVerified: false, ...data }
    this.users.set(user.id, user)
    return user
  }

  async update(id: string, patch: UserPatch): Promise<AuthUser | null> {
    const user = this.users.get(id)
    if (!user) return null
    Object.assign(user, patch)
    return user
  }
}

// --- one-time tokens (email verification, password reset) ------------------

export type AuthTokenPurpose = 'verify_email' | 'reset_password'

export interface AuthTokenRecord {
  token: string
  userId: string
  purpose: AuthTokenPurpose
  expiresAt: number
  usedAt?: number
}

/** Stores single-use, expiring tokens for verification and reset flows. */
export interface AuthTokenStore {
  create(record: AuthTokenRecord): Promise<void>
  find(token: string): Promise<AuthTokenRecord | null>
  markUsed(token: string): Promise<void>
  /** Invalidate outstanding tokens of a purpose for a user before issuing a new one. */
  deleteForUser(userId: string, purpose: AuthTokenPurpose): Promise<void>
}

export class MemoryAuthTokenStore implements AuthTokenStore {
  private readonly records = new Map<string, AuthTokenRecord>()

  async create(record: AuthTokenRecord): Promise<void> {
    this.records.set(record.token, record)
  }
  async find(token: string): Promise<AuthTokenRecord | null> {
    return this.records.get(token) ?? null
  }
  async markUsed(token: string): Promise<void> {
    const record = this.records.get(token)
    if (record) record.usedAt = Date.now()
  }
  async deleteForUser(userId: string, purpose: AuthTokenPurpose): Promise<void> {
    for (const [token, record] of this.records) {
      if (record.userId === userId && record.purpose === purpose) this.records.delete(token)
    }
  }
}

// --- API keys ---------------------------------------------------------------

/**
 * A stored API key. The plaintext key is never persisted — only its SHA-256
 * `hash` (for O(1) lookup) and a short `prefix` (for display in listings).
 */
export interface ApiKeyRecord {
  id: string
  /** Human label, e.g. "CI pipeline". */
  name: string
  /** Visible portion shown in listings, e.g. `mk_live_ab12cd`. */
  prefix: string
  /** SHA-256 of the full presented key. */
  hash: string
  /** Owning tenant, when created inside a tenant context. */
  tenantId?: string
  /** User who created the key, when created by a logged-in user. */
  userId?: string
  /** Granted scopes; `*` means all. */
  scopes: string[]
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
}

/** What a listing exposes — never the hash. */
export type ApiKeyInfo = Omit<ApiKeyRecord, 'hash'>

export interface ApiKeyFilter {
  tenantId?: string
  userId?: string
}

export interface ApiKeyStore {
  create(record: ApiKeyRecord): Promise<void>
  findByHash(hash: string): Promise<ApiKeyRecord | null>
  findById(id: string): Promise<ApiKeyRecord | null>
  /** Active (non-revoked) keys matching the filter. */
  list(filter: ApiKeyFilter): Promise<ApiKeyRecord[]>
  touch(id: string, at: number): Promise<void>
  revoke(id: string, at: number): Promise<void>
}

export class MemoryApiKeyStore implements ApiKeyStore {
  private readonly records = new Map<string, ApiKeyRecord>()

  async create(record: ApiKeyRecord): Promise<void> {
    this.records.set(record.id, record)
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    for (const record of this.records.values()) {
      if (record.hash === hash) return record
    }
    return null
  }

  async findById(id: string): Promise<ApiKeyRecord | null> {
    return this.records.get(id) ?? null
  }

  async list(filter: ApiKeyFilter): Promise<ApiKeyRecord[]> {
    const out: ApiKeyRecord[] = []
    for (const record of this.records.values()) {
      if (record.revokedAt !== undefined) continue
      if (filter.tenantId !== undefined && record.tenantId !== filter.tenantId) continue
      if (filter.userId !== undefined && record.userId !== filter.userId) continue
      out.push(record)
    }
    return out
  }

  async touch(id: string, at: number): Promise<void> {
    const record = this.records.get(id)
    if (record) record.lastUsedAt = at
  }

  async revoke(id: string, at: number): Promise<void> {
    const record = this.records.get(id)
    if (record) record.revokedAt = at
  }
}

// --- MFA (TOTP) -------------------------------------------------------------

/**
 * Per-user MFA state. `secret` is the base32 TOTP secret; `recoveryCodes`
 * holds SHA-256 hashes of single-use backup codes (never the plaintext).
 */
export interface MfaRecord {
  secret: string
  enabled: boolean
  recoveryCodes: string[]
  /**
   * The last TOTP step (counter) accepted for this user. Codes at a step ≤ this
   * are rejected, so an intercepted 6-digit code cannot be replayed within its
   * validity window (RFC 6238 §5.2). Undefined until the first accepted code.
   */
  lastUsedStep?: number
}

export interface MfaStore {
  get(userId: string): Promise<MfaRecord | null>
  set(userId: string, record: MfaRecord): Promise<void>
  delete(userId: string): Promise<void>
}

export class MemoryMfaStore implements MfaStore {
  private readonly records = new Map<string, MfaRecord>()

  async get(userId: string): Promise<MfaRecord | null> {
    return this.records.get(userId) ?? null
  }
  async set(userId: string, record: MfaRecord): Promise<void> {
    this.records.set(userId, record)
  }
  async delete(userId: string): Promise<void> {
    this.records.delete(userId)
  }
}

export interface SessionRecord {
  id: string
  userId: string
  expiresAt: number
}

export interface SessionStore {
  create(userId: string, ttlMs: number): Promise<SessionRecord>
  /** Returns null for unknown or expired sessions. */
  find(id: string): Promise<SessionRecord | null>
  delete(id: string): Promise<boolean>
  /**
   * Deletes every session for a user — fired on password reset so a reset logs
   * out all of the user's active sessions, not just token-based clients.
   * Optional so existing stores keep compiling; implement it to close the gap.
   */
  deleteAllForUser?(userId: string): Promise<void>
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()

  async create(userId: string, ttlMs: number): Promise<SessionRecord> {
    // Mint a raw id for the client (cookie), but key/store by its hash so a leak
    // of the session table can't be replayed as a live session.
    const rawId = randomBytes(32).toString('base64url')
    const hashed = hashSessionId(rawId)
    const expiresAt = Date.now() + ttlMs
    this.sessions.set(hashed, { id: hashed, userId, expiresAt })
    return { id: rawId, userId, expiresAt }
  }

  async find(id: string): Promise<SessionRecord | null> {
    const hashed = hashSessionId(id)
    const record = this.sessions.get(hashed)
    if (!record) return null
    if (Date.now() >= record.expiresAt) {
      this.sessions.delete(hashed)
      return null
    }
    // Echo the id the caller queried with (never the stored hash).
    return { id, userId: record.userId, expiresAt: record.expiresAt }
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(hashSessionId(id))
  }

  async deleteAllForUser(userId: string): Promise<void> {
    for (const [key, record] of this.sessions) {
      if (record.userId === userId) this.sessions.delete(key)
    }
  }
}

export interface RefreshRecord {
  token: string
  familyId: string
  userId: string
  expiresAt: number
  usedAt?: number
}

export interface RefreshTokenStore {
  create(record: RefreshRecord): Promise<void>
  find(token: string): Promise<RefreshRecord | null>
  markUsed(token: string): Promise<void>
  /** Revokes every token of a family — fired on reuse detection. */
  revokeFamily(familyId: string): Promise<void>
  /** Revokes every token of a user — fired on password reset. Optional. */
  revokeAllForUser?(userId: string): Promise<void>
}

export class MemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly records = new Map<string, RefreshRecord>()

  async create(record: RefreshRecord): Promise<void> {
    this.records.set(record.token, record)
  }

  async find(token: string): Promise<RefreshRecord | null> {
    return this.records.get(token) ?? null
  }

  async markUsed(token: string): Promise<void> {
    const record = this.records.get(token)
    if (record) record.usedAt = Date.now()
  }

  async revokeFamily(familyId: string): Promise<void> {
    for (const [token, record] of this.records) {
      if (record.familyId === familyId) this.records.delete(token)
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    for (const [token, record] of this.records) {
      if (record.userId === userId) this.records.delete(token)
    }
  }
}
