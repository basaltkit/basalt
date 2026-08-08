// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type { InAppNotification, InAppStore } from '@machize/notifications'

/**
 * Durable, SQLite-backed implementation of the `@machize/notifications`
 * `InAppStore`, on Node's built-in `node:sqlite`. Zero external dependencies.
 * The single-node reference backend; the production (Postgres/MySQL) counterpart
 * is `@machize/notifications-prisma`.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

export function openNotificationsDatabase(location = ':memory:'): DatabaseSync {
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
    CREATE TABLE IF NOT EXISTS in_app_notifications (
      id           TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL,
      notification TEXT NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT,
      data         TEXT,
      read_at      INTEGER,
      at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inapp_recipient ON in_app_notifications (recipient_id, at);
  `)
}

interface InAppRow {
  id: string
  recipient_id: string
  notification: string
  title: string
  body: string | null
  data: string | null
  read_at: number | null
  at: number
}

const toNotification = (r: InAppRow): InAppNotification => ({
  id: r.id,
  recipientId: r.recipient_id,
  notification: r.notification,
  title: r.title,
  at: r.at,
  ...(r.body !== null ? { body: r.body } : {}),
  ...(r.data !== null ? { data: JSON.parse(r.data) as unknown } : {}),
  ...(r.read_at !== null ? { readAt: r.read_at } : {}),
})

export class SqliteInAppStore implements InAppStore {
  constructor(private readonly db: DatabaseSync) {}

  async append(record: InAppNotification): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO in_app_notifications (id, recipient_id, notification, title, body, data, read_at, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.recipientId,
        record.notification,
        record.title,
        record.body ?? null,
        record.data === undefined ? null : JSON.stringify(record.data),
        record.readAt ?? null,
        record.at,
      )
  }

  async list(
    recipientId: string,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): Promise<InAppNotification[]> {
    let sql = 'SELECT * FROM in_app_notifications WHERE recipient_id = ?'
    const args: (string | number)[] = [recipientId]
    if (options.unreadOnly) sql += ' AND read_at IS NULL'
    sql += ' ORDER BY at DESC, rowid DESC' // newest first, ties by insertion order
    if (options.limit !== undefined) {
      sql += ' LIMIT ?'
      args.push(options.limit)
    }
    const rows = this.db.prepare(sql).all(...args) as unknown as InAppRow[]
    return rows.map(toNotification)
  }

  async markRead(recipientId: string, id: string): Promise<boolean> {
    // Marks only an existing, still-unread notification — the guard makes this
    // idempotent and returns whether it actually changed anything.
    const info = this.db
      .prepare('UPDATE in_app_notifications SET read_at = ? WHERE id = ? AND recipient_id = ? AND read_at IS NULL')
      .run(Date.now(), id, recipientId)
    return info.changes > 0
  }

  async unreadCount(recipientId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM in_app_notifications WHERE recipient_id = ? AND read_at IS NULL')
      .get(recipientId) as { n: number }
    return row.n
  }
}

export interface SqliteNotificationsStores {
  db: DatabaseSync
  store: SqliteInAppStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the in-app store wired
 * to it, named to drop straight into `notificationsPlugin`:
 *
 * ```ts
 * const n = sqliteInAppStore('./data/notifications.db')
 * notificationsPlugin({ inApp: n.store, mailer })
 * ```
 */
export function sqliteInAppStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteNotificationsStores {
  const db = typeof dbOrLocation === 'string' ? openNotificationsDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, store: new SqliteInAppStore(db) }
}
