import { DatabaseSync } from 'node:sqlite'
import type { ActivityQuery, ActivityRecord, ActivityStore } from '@machize/activity'

/**
 * Durable, SQLite-backed implementation of the `@machize/activity`
 * `ActivityStore`, on Node's built-in `node:sqlite`. Zero external dependencies.
 * The single-node reference backend; the production (Postgres/MySQL) counterpart
 * is `@machize/activity-prisma`.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

export function openActivityDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location)
  migrate(db)
  return db
}

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_records (
      id           TEXT PRIMARY KEY,
      log          TEXT NOT NULL,
      description  TEXT NOT NULL,
      subject_type TEXT,
      subject_id   TEXT,
      causer_id    TEXT,
      tenant_id    TEXT,
      properties   TEXT,
      at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_records (tenant_id, at);
    CREATE INDEX IF NOT EXISTS idx_activity_subject ON activity_records (subject_type, subject_id);
  `)
}

interface ActivityRow {
  id: string
  log: string
  description: string
  subject_type: string | null
  subject_id: string | null
  causer_id: string | null
  tenant_id: string | null
  properties: string | null
  at: number
}

const toRecord = (r: ActivityRow): ActivityRecord => ({
  id: r.id,
  log: r.log,
  description: r.description,
  subjectType: r.subject_type ?? undefined,
  subjectId: r.subject_id ?? undefined,
  causerId: r.causer_id ?? undefined,
  tenantId: r.tenant_id ?? undefined,
  properties: r.properties === null ? undefined : (JSON.parse(r.properties) as Record<string, unknown>),
  at: r.at,
})

type Bindable = null | number | string

export class SqliteActivityStore implements ActivityStore {
  constructor(private readonly db: DatabaseSync) {}

  async append(record: ActivityRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO activity_records (id, log, description, subject_type, subject_id, causer_id, tenant_id, properties, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.log,
        record.description,
        record.subjectType ?? null,
        record.subjectId ?? null,
        record.causerId ?? null,
        record.tenantId ?? null,
        record.properties === undefined ? null : JSON.stringify(record.properties),
        record.at,
      )
  }

  async query(query: ActivityQuery): Promise<ActivityRecord[]> {
    const where: string[] = []
    const args: Bindable[] = []
    const eq = (column: string, value: string | undefined): void => {
      if (value !== undefined) {
        where.push(`${column} = ?`)
        args.push(value)
      }
    }
    eq('log', query.log)
    eq('subject_type', query.subjectType)
    eq('subject_id', query.subjectId)
    eq('causer_id', query.causerId)
    eq('tenant_id', query.tenantId)
    let sql =
      'SELECT * FROM activity_records' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY at DESC, rowid DESC' // newest first, ties by insertion order
    if (query.limit !== undefined) {
      sql += ' LIMIT ?'
      args.push(query.limit)
    }
    const rows = this.db.prepare(sql).all(...args) as unknown as ActivityRow[]
    return rows.map(toRecord)
  }
}

export interface SqliteActivityStores {
  db: DatabaseSync
  store: SqliteActivityStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the activity store wired
 * to it, named to drop straight into `activityPlugin`:
 *
 * ```ts
 * const a = sqliteActivityStore('./data/activity.db')
 * activityPlugin({ store: a.store })
 * ```
 */
export function sqliteActivityStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteActivityStores {
  const db = typeof dbOrLocation === 'string' ? openActivityDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, store: new SqliteActivityStore(db) }
}
