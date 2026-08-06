import { randomBytes, randomUUID } from 'node:crypto'

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
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()

  async create(userId: string, ttlMs: number): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: randomBytes(32).toString('base64url'),
      userId,
      expiresAt: Date.now() + ttlMs,
    }
    this.sessions.set(record.id, record)
    return record
  }

  async find(id: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(id)
    if (!record) return null
    if (Date.now() >= record.expiresAt) {
      this.sessions.delete(id)
      return null
    }
    return record
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id)
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
