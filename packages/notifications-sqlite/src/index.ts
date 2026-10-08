// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type {
  InAppNotification,
  InAppPruneOptions,
  InAppStore,
  NotificationPreference,
  PreferenceStore,
} from '@basaltkit/notifications'

/**
 * Durable, SQLite-backed implementation of the `@basaltkit/notifications`
 * `InAppStore`, on Node's built-in `node:sqlite`. Zero external dependencies.
 * The single-node reference backend; the production (Postgres/MySQL) counterpart
 * is `@basaltkit/notifications-prisma`.
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
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id      TEXT NOT NULL,
      notification TEXT NOT NULL,
      channel      TEXT NOT NULL,
      enabled      INTEGER NOT NULL,
      PRIMARY KEY (user_id, notification, channel)
    );
  `)
  // Columns added after the table first shipped: a database created by an
  // older version gets them here, so upgrading needs no manual step.
  const columns = new Set(
    (db.prepare('PRAGMA table_info(in_app_notifications)').all() as unknown as { name: string }[]).map((c) => c.name),
  )
  if (!columns.has('group_key')) db.exec('ALTER TABLE in_app_notifications ADD COLUMN group_key TEXT')
  if (!columns.has('count')) db.exec('ALTER TABLE in_app_notifications ADD COLUMN count INTEGER')
  db.exec('CREATE INDEX IF NOT EXISTS idx_inapp_group ON in_app_notifications (recipient_id, group_key)')
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
  group_key: string | null
  count: number | null
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
  ...(r.group_key !== null ? { groupKey: r.group_key } : {}),
  ...(r.count !== null ? { count: r.count } : {}),
})

export class SqliteInAppStore implements InAppStore {
  constructor(private readonly db: DatabaseSync) {}

  async append(record: InAppNotification): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO in_app_notifications (id, recipient_id, notification, title, body, data, read_at, at, group_key, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.groupKey ?? null,
        record.count ?? null,
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

  async markAllRead(recipientId: string): Promise<number> {
    const info = this.db
      .prepare('UPDATE in_app_notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL')
      .run(Date.now(), recipientId)
    return Number(info.changes)
  }

  async prune(options: InAppPruneOptions): Promise<number> {
    let removed = 0
    if (options.readBefore !== undefined) {
      removed += Number(
        this.db
          .prepare('DELETE FROM in_app_notifications WHERE read_at IS NOT NULL AND read_at < ?')
          .run(options.readBefore).changes,
      )
    }
    if (options.unreadBefore !== undefined) {
      removed += Number(
        this.db
          .prepare('DELETE FROM in_app_notifications WHERE read_at IS NULL AND at < ?')
          .run(options.unreadBefore).changes,
      )
    }
    return removed
  }

  async upsertGroup(record: InAppNotification & { groupKey: string }): Promise<void> {
    // One statement: SQLite serialises writers, so two notifications of the
    // same group cannot both miss the unread row and insert twice.
    const info = this.db
      .prepare(
        `UPDATE in_app_notifications
            SET count = COALESCE(count, 1) + ?, title = ?, body = ?, data = ?, at = ?, notification = ?
          WHERE recipient_id = ? AND group_key = ? AND read_at IS NULL`,
      )
      .run(
        record.count ?? 1,
        record.title,
        record.body ?? null,
        record.data === undefined ? null : JSON.stringify(record.data),
        record.at,
        record.notification,
        record.recipientId,
        record.groupKey,
      )
    if (Number(info.changes) === 0) await this.append({ ...record, count: record.count ?? 1 })
  }
}

/**
 * Durable {@link PreferenceStore} for `notificationsPlugin({ preferences })`, in
 * the `notification_preferences` table of the same database.
 */
export class SqlitePreferenceStore implements PreferenceStore {
  constructor(private readonly db: DatabaseSync) {}

  async set(preference: NotificationPreference): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO notification_preferences (user_id, notification, channel, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, notification, channel) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(preference.userId, preference.notification, preference.channel, preference.enabled ? 1 : 0)
  }

  async list(userId: string): Promise<NotificationPreference[]> {
    const rows = this.db
      .prepare('SELECT user_id, notification, channel, enabled FROM notification_preferences WHERE user_id = ?')
      .all(userId) as unknown as { user_id: string; notification: string; channel: string; enabled: number }[]
    return rows.map((r) => ({ userId: r.user_id, notification: r.notification, channel: r.channel, enabled: r.enabled === 1 }))
  }

  async remove(userId: string, notification: string, channel: string): Promise<void> {
    this.db
      .prepare('DELETE FROM notification_preferences WHERE user_id = ? AND notification = ? AND channel = ?')
      .run(userId, notification, channel)
  }
}

export interface SqliteNotificationsStores {
  db: DatabaseSync
  store: SqliteInAppStore
  /** Durable per-user preferences, for `notificationsPlugin({ preferences })`. */
  preferences: SqlitePreferenceStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the in-app store wired
 * to it, named to drop straight into `notificationsPlugin`:
 *
 * ```ts
 * const n = sqliteInAppStore('./data/notifications.db')
 * notificationsPlugin({ inApp: n.store, preferences: n.preferences, mailer })
 * ```
 */
export function sqliteInAppStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteNotificationsStores {
  const db = typeof dbOrLocation === 'string' ? openNotificationsDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, store: new SqliteInAppStore(db), preferences: new SqlitePreferenceStore(db) }
}
