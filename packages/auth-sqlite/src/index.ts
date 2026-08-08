import { randomBytes, randomUUID } from 'node:crypto'
// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type {
  ApiKeyFilter,
  ApiKeyRecord,
  ApiKeyStore,
  AuthTokenPurpose,
  AuthTokenRecord,
  AuthTokenStore,
  AuthUser,
  MfaRecord,
  MfaStore,
  RefreshRecord,
  RefreshTokenStore,
  SessionRecord,
  SessionStore,
  UserPatch,
  UserSource,
} from '@machize/auth'

/**
 * A durable, SQLite-backed implementation of every `@machize/auth` store, built
 * on Node's built-in `node:sqlite` — zero external dependencies. It is the
 * reference "real backend" for auth: users, sessions, refresh tokens, one-time
 * tokens, API keys and MFA state all survive process restarts.
 *
 * `node:sqlite` is synchronous; the store methods stay `async` to satisfy the
 * contracts, so they drop into `authPlugin`/`apiKeysPlugin` unchanged.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; on 22.x it needs
 * `--experimental-sqlite`).
 */

// node:sqlite binds only null | number | bigint | string | Uint8Array —
// booleans and undefined are rejected. These map our domain values onto that.
type Bindable = null | number | bigint | string | Uint8Array
const bool = (v: boolean): number => (v ? 1 : 0)
const orNull = <T extends Bindable>(v: T | undefined): T | null => (v === undefined ? null : v)
const nowMs = (): number => Date.now()

/** Open (or create) an auth database and apply the schema. `:memory:` for tests. */
export function openAuthDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location)
  migrate(db)
  return db
}

/** Idempotent schema — safe to run on every open. */
export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      purpose    TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, purpose);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
      token      TEXT PRIMARY KEY,
      family_id  TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_family ON auth_refresh_tokens (family_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_user ON auth_refresh_tokens (user_id);

    CREATE TABLE IF NOT EXISTS auth_api_keys (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      prefix       TEXT NOT NULL,
      hash         TEXT NOT NULL UNIQUE,
      tenant_id    TEXT,
      user_id      TEXT,
      scopes       TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON auth_api_keys (hash);

    CREATE TABLE IF NOT EXISTS auth_mfa (
      user_id        TEXT PRIMARY KEY,
      secret         TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 0,
      recovery_codes TEXT NOT NULL
    );
  `)
}

// --- users ------------------------------------------------------------------

interface UserRow {
  id: string
  email: string
  password_hash: string
  email_verified: number
}

const toUser = (r: UserRow): AuthUser => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  emailVerified: r.email_verified === 1,
})

export class SqliteUserSource implements UserSource {
  constructor(private readonly db: DatabaseSync) {}

  async findByEmail(email: string): Promise<AuthUser | null> {
    const row = this.db
      .prepare('SELECT * FROM auth_users WHERE email = ?')
      .get(email) as UserRow | undefined
    return row ? toUser(row) : null
  }

  async findById(id: string): Promise<AuthUser | null> {
    const row = this.db
      .prepare('SELECT * FROM auth_users WHERE id = ?')
      .get(id) as UserRow | undefined
    return row ? toUser(row) : null
  }

  async create(data: { email: string; passwordHash: string }): Promise<AuthUser> {
    const user: AuthUser = { id: randomUUID(), email: data.email, passwordHash: data.passwordHash, emailVerified: false }
    this.db
      .prepare('INSERT INTO auth_users (id, email, password_hash, email_verified) VALUES (?, ?, ?, 0)')
      .run(user.id, user.email, user.passwordHash)
    return user
  }

  async update(id: string, patch: UserPatch): Promise<AuthUser | null> {
    const sets: string[] = []
    const args: Bindable[] = []
    if (patch.passwordHash !== undefined) {
      sets.push('password_hash = ?')
      args.push(patch.passwordHash)
    }
    if (patch.emailVerified !== undefined) {
      sets.push('email_verified = ?')
      args.push(bool(patch.emailVerified))
    }
    if (sets.length > 0) {
      args.push(id)
      this.db.prepare(`UPDATE auth_users SET ${sets.join(', ')} WHERE id = ?`).run(...args)
    }
    return this.findById(id)
  }
}

// --- one-time tokens --------------------------------------------------------

interface AuthTokenRow {
  token: string
  user_id: string
  purpose: string
  expires_at: number
  used_at: number | null
}

const toAuthToken = (r: AuthTokenRow): AuthTokenRecord => {
  const rec: AuthTokenRecord = {
    token: r.token,
    userId: r.user_id,
    purpose: r.purpose as AuthTokenPurpose,
    expiresAt: r.expires_at,
  }
  if (r.used_at !== null) rec.usedAt = r.used_at
  return rec
}

export class SqliteAuthTokenStore implements AuthTokenStore {
  constructor(private readonly db: DatabaseSync) {}

  async create(record: AuthTokenRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO auth_tokens (token, user_id, purpose, expires_at, used_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.token, record.userId, record.purpose, record.expiresAt, orNull(record.usedAt))
  }

  async find(token: string): Promise<AuthTokenRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM auth_tokens WHERE token = ?')
      .get(token) as AuthTokenRow | undefined
    return row ? toAuthToken(row) : null
  }

  async markUsed(token: string): Promise<void> {
    this.db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token = ?').run(nowMs(), token)
  }

  async deleteForUser(userId: string, purpose: AuthTokenPurpose): Promise<void> {
    this.db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose)
  }
}

// --- sessions ---------------------------------------------------------------

interface SessionRow {
  id: string
  user_id: string
  expires_at: number
}

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  async create(userId: string, ttlMs: number): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: randomBytes(32).toString('base64url'),
      userId,
      expiresAt: nowMs() + ttlMs,
    }
    this.db
      .prepare('INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .run(record.id, record.userId, record.expiresAt)
    return record
  }

  async find(id: string): Promise<SessionRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM auth_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined
    if (!row) return null
    if (nowMs() >= row.expires_at) {
      this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id)
      return null
    }
    return { id: row.id, userId: row.user_id, expiresAt: row.expires_at }
  }

  async delete(id: string): Promise<boolean> {
    const info = this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id)
    return info.changes > 0
  }
}

// --- refresh tokens ---------------------------------------------------------

interface RefreshRow {
  token: string
  family_id: string
  user_id: string
  expires_at: number
  used_at: number | null
}

const toRefresh = (r: RefreshRow): RefreshRecord => {
  const rec: RefreshRecord = {
    token: r.token,
    familyId: r.family_id,
    userId: r.user_id,
    expiresAt: r.expires_at,
  }
  if (r.used_at !== null) rec.usedAt = r.used_at
  return rec
}

export class SqliteRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly db: DatabaseSync) {}

  async create(record: RefreshRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO auth_refresh_tokens (token, family_id, user_id, expires_at, used_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.token, record.familyId, record.userId, record.expiresAt, orNull(record.usedAt))
  }

  async find(token: string): Promise<RefreshRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM auth_refresh_tokens WHERE token = ?')
      .get(token) as RefreshRow | undefined
    return row ? toRefresh(row) : null
  }

  async markUsed(token: string): Promise<void> {
    this.db.prepare('UPDATE auth_refresh_tokens SET used_at = ? WHERE token = ?').run(nowMs(), token)
  }

  async revokeFamily(familyId: string): Promise<void> {
    this.db.prepare('DELETE FROM auth_refresh_tokens WHERE family_id = ?').run(familyId)
  }

  async revokeAllForUser(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?').run(userId)
  }
}

// --- API keys ---------------------------------------------------------------

interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  hash: string
  tenant_id: string | null
  user_id: string | null
  scopes: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

const toApiKey = (r: ApiKeyRow): ApiKeyRecord => {
  const rec: ApiKeyRecord = {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    hash: r.hash,
    scopes: JSON.parse(r.scopes) as string[],
    createdAt: r.created_at,
  }
  if (r.tenant_id !== null) rec.tenantId = r.tenant_id
  if (r.user_id !== null) rec.userId = r.user_id
  if (r.last_used_at !== null) rec.lastUsedAt = r.last_used_at
  if (r.revoked_at !== null) rec.revokedAt = r.revoked_at
  return rec
}

export class SqliteApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: DatabaseSync) {}

  async create(record: ApiKeyRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO auth_api_keys
           (id, name, prefix, hash, tenant_id, user_id, scopes, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.prefix,
        record.hash,
        orNull(record.tenantId),
        orNull(record.userId),
        JSON.stringify(record.scopes),
        record.createdAt,
        orNull(record.lastUsedAt),
        orNull(record.revokedAt),
      )
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM auth_api_keys WHERE hash = ?')
      .get(hash) as ApiKeyRow | undefined
    return row ? toApiKey(row) : null
  }

  async findById(id: string): Promise<ApiKeyRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM auth_api_keys WHERE id = ?')
      .get(id) as ApiKeyRow | undefined
    return row ? toApiKey(row) : null
  }

  async list(filter: ApiKeyFilter): Promise<ApiKeyRecord[]> {
    const where: string[] = ['revoked_at IS NULL']
    const args: Bindable[] = []
    if (filter.tenantId !== undefined) {
      where.push('tenant_id = ?')
      args.push(filter.tenantId)
    }
    if (filter.userId !== undefined) {
      where.push('user_id = ?')
      args.push(filter.userId)
    }
    const rows = this.db
      .prepare(`SELECT * FROM auth_api_keys WHERE ${where.join(' AND ')} ORDER BY created_at`)
      .all(...args) as unknown as ApiKeyRow[]
    return rows.map(toApiKey)
  }

  async touch(id: string, at: number): Promise<void> {
    this.db.prepare('UPDATE auth_api_keys SET last_used_at = ? WHERE id = ?').run(at, id)
  }

  async revoke(id: string, at: number): Promise<void> {
    this.db.prepare('UPDATE auth_api_keys SET revoked_at = ? WHERE id = ?').run(at, id)
  }
}

// --- MFA --------------------------------------------------------------------

interface MfaRow {
  user_id: string
  secret: string
  enabled: number
  recovery_codes: string
}

export class SqliteMfaStore implements MfaStore {
  constructor(private readonly db: DatabaseSync) {}

  async get(userId: string): Promise<MfaRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM auth_mfa WHERE user_id = ?')
      .get(userId) as MfaRow | undefined
    if (!row) return null
    return {
      secret: row.secret,
      enabled: row.enabled === 1,
      recoveryCodes: JSON.parse(row.recovery_codes) as string[],
    }
  }

  async set(userId: string, record: MfaRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO auth_mfa (user_id, secret, enabled, recovery_codes) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = excluded.enabled, recovery_codes = excluded.recovery_codes`,
      )
      .run(userId, record.secret, bool(record.enabled), JSON.stringify(record.recoveryCodes))
  }

  async delete(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM auth_mfa WHERE user_id = ?').run(userId)
  }
}

// --- convenience ------------------------------------------------------------

export interface SqliteAuthStores {
  db: DatabaseSync
  users: SqliteUserSource
  sessions: SqliteSessionStore
  refreshTokens: SqliteRefreshTokenStore
  tokens: SqliteAuthTokenStore
  apiKeys: SqliteApiKeyStore
  mfa: SqliteMfaStore
}

/**
 * Open a database (or reuse a `DatabaseSync` you already have) and return every
 * auth store wired to it, named to drop straight into `authPlugin` /
 * `apiKeysPlugin`:
 *
 * ```ts
 * const s = sqliteAuthStores('./data/auth.db')
 * authPlugin({ users: s.users, sessions: s.sessions, refreshTokens: s.refreshTokens,
 *              tokens: s.tokens, mfa: s.mfa, secret })
 * apiKeysPlugin({ store: s.apiKeys, users: s.users })
 * ```
 */
export function sqliteAuthStores(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteAuthStores {
  const db = typeof dbOrLocation === 'string' ? openAuthDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return {
    db,
    users: new SqliteUserSource(db),
    sessions: new SqliteSessionStore(db),
    refreshTokens: new SqliteRefreshTokenStore(db),
    tokens: new SqliteAuthTokenStore(db),
    apiKeys: new SqliteApiKeyStore(db),
    mfa: new SqliteMfaStore(db),
  }
}
