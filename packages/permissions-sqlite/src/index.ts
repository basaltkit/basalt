// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type { AccessStore } from '@basaltkit/permissions'

/**
 * Durable, SQLite-backed implementation of the `@basaltkit/permissions`
 * `AccessStore`, on Node's built-in `node:sqlite`. Zero external dependencies.
 * The single-node reference backend; the production (Postgres/MySQL) counterpart
 * is `@basaltkit/permissions-prisma`.
 *
 * Role assignments and permission grants are sets — every write is an
 * `INSERT OR IGNORE`, so re-granting is a harmless no-op.
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

export interface SqlitePermissionsStores {
  db: DatabaseSync
  store: SqliteAccessStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the access store wired
 * to it, named to drop straight into `permissionsPlugin`:
 *
 * ```ts
 * const p = sqliteAccessStore('./data/permissions.db')
 * permissionsPlugin({ store: p.store })
 * ```
 */
export function sqliteAccessStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqlitePermissionsStores {
  const db = typeof dbOrLocation === 'string' ? openPermissionsDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, store: new SqliteAccessStore(db) }
}
