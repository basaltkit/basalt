// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type { AccessStore } from '@machize/permissions'

/**
 * Durable, SQLite-backed implementation of the `@machize/permissions`
 * `AccessStore`, on Node's built-in `node:sqlite`. Zero external dependencies.
 * The single-node reference backend; the production (Postgres/MySQL) counterpart
 * is `@machize/permissions-prisma`.
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
    this.db
      .prepare('INSERT OR IGNORE INTO perm_user_roles (scope, user_id, role) VALUES (?, ?, ?)')
      .run(scope, userId, role)
  }

  async removeRole(userId: string, role: string, scope: string): Promise<void> {
    this.db
      .prepare('DELETE FROM perm_user_roles WHERE scope = ? AND user_id = ? AND role = ?')
      .run(scope, userId, role)
  }

  async grantToRole(role: string, permissions: string[], scope: string): Promise<void> {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO perm_role_permissions (scope, role, permission) VALUES (?, ?, ?)')
    for (const permission of permissions) stmt.run(scope, role, permission)
  }

  async grantToUser(userId: string, permissions: string[], scope: string): Promise<void> {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO perm_user_permissions (scope, user_id, permission) VALUES (?, ?, ?)')
    for (const permission of permissions) stmt.run(scope, userId, permission)
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
