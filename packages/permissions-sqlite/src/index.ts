// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type { AccessStore, Delegation, DelegationStore, TemporaryGrant, TemporaryGrantStore } from '@basaltkit/permissions'

/**
 * Durable, SQLite-backed implementation of the `@basaltkit/permissions`
 * `AccessStore`, on Node's built-in `node:sqlite`. Zero external dependencies.
 * The single-node reference backend; the production (Postgres/MySQL) counterpart
 * is `@basaltkit/permissions-prisma`.
 *
 * Role assignments and permission grants are sets — every write is an
 * `INSERT OR IGNORE`, so re-granting is a harmless no-op. The same database
 * also backs the durable `TemporaryGrantStore` and `DelegationStore`
 * ({@link SqliteTemporaryGrantStore}, {@link SqliteDelegationStore}).
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

export function openPermissionsDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location)
  migrate(db)
  return db
}

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  // Wait up to 5s for a competing writer's lock instead of throwing
  // 'database is locked' immediately — smooths over dev reloads / concurrency.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS perm_user_roles (
      scope   TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role    TEXT NOT NULL,
      PRIMARY KEY (scope, user_id, role)
    );
    CREATE TABLE IF NOT EXISTS perm_user_permissions (
      scope      TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY (scope, user_id, permission)
    );
    CREATE TABLE IF NOT EXISTS perm_role_permissions (
      scope      TEXT NOT NULL,
      role       TEXT NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY (scope, role, permission)
    );
    CREATE TABLE IF NOT EXISTS perm_temporary_grants (
      id          TEXT PRIMARY KEY,
      scope       TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      permissions TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      granted_by  TEXT,
      reason      TEXT
    );
    CREATE INDEX IF NOT EXISTS perm_temporary_grants_lookup
      ON perm_temporary_grants (scope, user_id, expires_at);
    CREATE TABLE IF NOT EXISTS perm_delegations (
      id           TEXT PRIMARY KEY,
      scope        TEXT NOT NULL,
      from_user_id TEXT NOT NULL,
      to_user_id   TEXT NOT NULL,
      permissions  TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS perm_delegations_to ON perm_delegations (scope, to_user_id);
    CREATE INDEX IF NOT EXISTS perm_delegations_from ON perm_delegations (scope, from_user_id);
  `)
}

/**
 * Direct writes validate what they persist: an empty or non-string user id,
 * role name or scope is refused with a `TypeError` instead of being written.
 * `''`, `null` and `undefined` would otherwise collapse into one shared
 * "nobody" key whose grants are honoured for every caller with a missing id.
 * (The Gate validates too; these guards cover code that writes to the store
 * directly — seed scripts, admin tools, migrations.)
 */
function assertKey(value: unknown, what: string, operation: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${operation}: ${what} must be a non-empty string`)
  }
}

function assertPermissionList(value: unknown, operation: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new TypeError(`${operation}: permissions must be an array of non-empty strings`)
  }
}

export class SqliteAccessStore implements AccessStore {
  constructor(private readonly db: DatabaseSync) {}

  async getUserRoles(userId: string, scope: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT role FROM perm_user_roles WHERE scope = ? AND user_id = ? ORDER BY rowid')
      .all(scope, userId) as unknown as { role: string }[]
    return rows.map((r) => r.role)
  }

  async getUserPermissions(userId: string, scope: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT permission FROM perm_user_permissions WHERE scope = ? AND user_id = ? ORDER BY rowid')
      .all(scope, userId) as unknown as { permission: string }[]
    return rows.map((r) => r.permission)
  }

  async getRolePermissions(role: string, scope: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT permission FROM perm_role_permissions WHERE scope = ? AND role = ? ORDER BY rowid')
      .all(scope, role) as unknown as { permission: string }[]
    return rows.map((r) => r.permission)
  }

  async assignRole(userId: string, role: string, scope: string): Promise<void> {
    assertKey(userId, 'userId', 'assignRole')
    assertKey(role, 'role', 'assignRole')
    assertKey(scope, 'scope', 'assignRole')
    this.db
      .prepare('INSERT OR IGNORE INTO perm_user_roles (scope, user_id, role) VALUES (?, ?, ?)')
      .run(scope, userId, role)
  }

  async removeRole(userId: string, role: string, scope: string): Promise<void> {
    assertKey(userId, 'userId', 'removeRole')
    assertKey(role, 'role', 'removeRole')
    assertKey(scope, 'scope', 'removeRole')
    this.db
      .prepare('DELETE FROM perm_user_roles WHERE scope = ? AND user_id = ? AND role = ?')
      .run(scope, userId, role)
  }

  async grantToRole(role: string, permissions: string[], scope: string): Promise<void> {
    assertKey(role, 'role', 'grantToRole')
    assertPermissionList(permissions, 'grantToRole')
    assertKey(scope, 'scope', 'grantToRole')
    const stmt = this.db.prepare('INSERT OR IGNORE INTO perm_role_permissions (scope, role, permission) VALUES (?, ?, ?)')
    this.atomically(() => {
      for (const permission of permissions) stmt.run(scope, role, permission)
    })
  }

  async grantToUser(userId: string, permissions: string[], scope: string): Promise<void> {
    assertKey(userId, 'userId', 'grantToUser')
    assertPermissionList(permissions, 'grantToUser')
    assertKey(scope, 'scope', 'grantToUser')
    const stmt = this.db.prepare('INSERT OR IGNORE INTO perm_user_permissions (scope, user_id, permission) VALUES (?, ?, ?)')
    this.atomically(() => {
      for (const permission of permissions) stmt.run(scope, userId, permission)
    })
  }

  /**
   * All of a multi-row grant, or none of it. A SAVEPOINT rather than BEGIN, so
   * it also nests inside a transaction the caller already opened on this db.
   */
  private atomically(fn: () => void): void {
    this.db.exec('SAVEPOINT basalt_perm_grant')
    try {
      fn()
    } catch (error) {
      this.db.exec('ROLLBACK TO basalt_perm_grant')
      this.db.exec('RELEASE basalt_perm_grant')
      throw error
    }
    this.db.exec('RELEASE basalt_perm_grant')
  }
}

// --- temporary grants & delegations ----------------------------------------

/** A finite epoch-ms timestamp — `Infinity`/`NaN` would be stored as REAL/NULL and read back as something else. */
function assertInstant(value: unknown, what: string, operation: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${operation}: ${what} must be a finite epoch-ms timestamp`)
  }
}

function assertOptionalText(value: unknown, what: string, operation: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`${operation}: ${what} must be a string when set`)
  }
}

/** The `permissions` column: a JSON array of strings. Anything else reads as empty. */
function permissionsOf(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

interface TemporaryGrantRow {
  id: string
  scope: string
  user_id: string
  permissions: string
  expires_at: number
  granted_by: string | null
  reason: string | null
}

interface DelegationRow {
  id: string
  scope: string
  from_user_id: string
  to_user_id: string
  permissions: string
  created_at: number
  expires_at: number | null
}

/**
 * Durable `TemporaryGrantStore` (table `perm_temporary_grants`, created by
 * `migrate()`). `activeFor` filters `expires_at > now`, user and scope in SQL;
 * the Gate re-verifies all three on every row anyway. Expired rows are inert —
 * `pruneExpired()` deletes them.
 */
export class SqliteTemporaryGrantStore implements TemporaryGrantStore {
  constructor(private readonly db: DatabaseSync) {}

  async add(grant: TemporaryGrant): Promise<void> {
    assertKey(grant?.id, 'id', 'TemporaryGrantStore.add')
    assertKey(grant.userId, 'userId', 'TemporaryGrantStore.add')
    assertKey(grant.scope, 'scope', 'TemporaryGrantStore.add')
    assertPermissionList(grant.permissions, 'TemporaryGrantStore.add')
    assertInstant(grant.expiresAt, 'expiresAt', 'TemporaryGrantStore.add')
    assertOptionalText(grant.grantedBy, 'grantedBy', 'TemporaryGrantStore.add')
    assertOptionalText(grant.reason, 'reason', 'TemporaryGrantStore.add')
    // Same id replaces, like the in-memory store.
    this.db
      .prepare(
        `INSERT OR REPLACE INTO perm_temporary_grants (id, scope, user_id, permissions, expires_at, granted_by, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.id,
        grant.scope,
        grant.userId,
        JSON.stringify(grant.permissions),
        grant.expiresAt,
        grant.grantedBy ?? null,
        grant.reason ?? null,
      )
  }

  async activeFor(userId: string, scope: string, now: number): Promise<TemporaryGrant[]> {
    const rows = this.db
      .prepare('SELECT * FROM perm_temporary_grants WHERE scope = ? AND user_id = ? AND expires_at > ? ORDER BY rowid')
      .all(scope, userId, now) as unknown as TemporaryGrantRow[]
    return rows.map(toTemporaryGrant)
  }

  async revoke(id: string): Promise<void> {
    assertKey(id, 'id', 'TemporaryGrantStore.revoke')
    this.db.prepare('DELETE FROM perm_temporary_grants WHERE id = ?').run(id)
  }

  async all(): Promise<TemporaryGrant[]> {
    const rows = this.db.prepare('SELECT * FROM perm_temporary_grants ORDER BY rowid').all() as unknown as TemporaryGrantRow[]
    return rows.map(toTemporaryGrant)
  }

  /** Deletes grants expired at `now` (default: the current time). Returns how many. */
  async pruneExpired(now: number = Date.now()): Promise<number> {
    return Number(this.db.prepare('DELETE FROM perm_temporary_grants WHERE expires_at <= ?').run(now).changes)
  }
}

function toTemporaryGrant(row: TemporaryGrantRow): TemporaryGrant {
  return {
    id: row.id,
    userId: row.user_id,
    permissions: permissionsOf(row.permissions),
    scope: row.scope,
    expiresAt: Number(row.expires_at),
    ...(row.granted_by !== null ? { grantedBy: row.granted_by } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  }
}

/**
 * Durable `DelegationStore` (table `perm_delegations`, created by `migrate()`).
 * `activeTo`/`activeFrom` return open-ended delegations (`expires_at` NULL) and
 * those with `expires_at > now`, in the given scope only; the Gate re-verifies
 * each row.
 */
export class SqliteDelegationStore implements DelegationStore {
  constructor(private readonly db: DatabaseSync) {}

  async add(delegation: Delegation): Promise<void> {
    assertKey(delegation?.id, 'id', 'DelegationStore.add')
    assertKey(delegation.fromUserId, 'fromUserId', 'DelegationStore.add')
    assertKey(delegation.toUserId, 'toUserId', 'DelegationStore.add')
    assertKey(delegation.scope, 'scope', 'DelegationStore.add')
    assertPermissionList(delegation.permissions, 'DelegationStore.add')
    assertInstant(delegation.createdAt, 'createdAt', 'DelegationStore.add')
    if (delegation.expiresAt !== undefined) assertInstant(delegation.expiresAt, 'expiresAt', 'DelegationStore.add')
    this.db
      .prepare(
        `INSERT OR REPLACE INTO perm_delegations (id, scope, from_user_id, to_user_id, permissions, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delegation.id,
        delegation.scope,
        delegation.fromUserId,
        delegation.toUserId,
        JSON.stringify(delegation.permissions),
        delegation.createdAt,
        delegation.expiresAt ?? null,
      )
  }

  async activeTo(toUserId: string, scope: string, now: number): Promise<Delegation[]> {
    return this.active('to_user_id', toUserId, scope, now)
  }

  async activeFrom(fromUserId: string, scope: string, now: number): Promise<Delegation[]> {
    return this.active('from_user_id', fromUserId, scope, now)
  }

  private active(column: 'to_user_id' | 'from_user_id', userId: string, scope: string, now: number): Delegation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM perm_delegations
         WHERE scope = ? AND ${column} = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY rowid`,
      )
      .all(scope, userId, now) as unknown as DelegationRow[]
    return rows.map(toDelegation)
  }

  async revoke(id: string): Promise<void> {
    assertKey(id, 'id', 'DelegationStore.revoke')
    this.db.prepare('DELETE FROM perm_delegations WHERE id = ?').run(id)
  }

  async all(): Promise<Delegation[]> {
    const rows = this.db.prepare('SELECT * FROM perm_delegations ORDER BY rowid').all() as unknown as DelegationRow[]
    return rows.map(toDelegation)
  }

  /** Deletes delegations whose deadline passed at `now`; open-ended ones stay. Returns how many. */
  async pruneExpired(now: number = Date.now()): Promise<number> {
    return Number(this.db.prepare('DELETE FROM perm_delegations WHERE expires_at <= ?').run(now).changes)
  }
}

function toDelegation(row: DelegationRow): Delegation {
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    permissions: permissionsOf(row.permissions),
    scope: row.scope,
    createdAt: Number(row.created_at),
    ...(row.expires_at !== null ? { expiresAt: Number(row.expires_at) } : {}),
  }
}

export interface SqlitePermissionsStores {
  db: DatabaseSync
  store: SqliteAccessStore
  /** Durable time-boxed grants — pass as `permissionsPlugin({ temporaryGrants })`. */
  temporaryGrants: SqliteTemporaryGrantStore
  /** Durable delegations — pass as `permissionsPlugin({ delegations })`. */
  delegations: SqliteDelegationStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the access store wired
 * to it, named to drop straight into `permissionsPlugin`:
 *
 * ```ts
 * const p = sqliteAccessStore('./data/permissions.db')
 * permissionsPlugin({ store: p.store, temporaryGrants: p.temporaryGrants, delegations: p.delegations })
 * ```
 */
export function sqliteAccessStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqlitePermissionsStores {
  const db = typeof dbOrLocation === 'string' ? openPermissionsDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return {
    db,
    store: new SqliteAccessStore(db),
    temporaryGrants: new SqliteTemporaryGrantStore(db),
    delegations: new SqliteDelegationStore(db),
  }
}
