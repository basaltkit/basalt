// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import {
  AUDIT_SCAN_PAGE,
  type AuditEntry,
  type AuditQuery,
  type AuditStore,
  exactEventMatch,
  patternMatches,
} from '@basaltkit/audit'

/**
 * Durable, SQLite-backed implementation of the `@basaltkit/audit` `AuditStore`, on
 * Node's built-in `node:sqlite`. Append-only by contract. Zero external
 * dependencies. The single-node reference backend; the production
 * (Postgres/MySQL) counterpart is `@basaltkit/audit-prisma`.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

export function openAuditDatabase(location = ':memory:'): DatabaseSync {
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
    CREATE TABLE IF NOT EXISTS audit_entries (
      id         TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      event      TEXT NOT NULL,
      payload    TEXT,
      actor_id   TEXT,
      tenant_id  TEXT,
      request_id TEXT,
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_entries (tenant_id, at);
  `)
}

interface AuditRow {
  id: string
  source: string
  event: string
  payload: string | null
  actor_id: string | null
  tenant_id: string | null
  request_id: string | null
  at: number
}

const toEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  source: r.source as AuditEntry['source'],
  event: r.event,
  payload: r.payload === null ? undefined : (JSON.parse(r.payload) as unknown),
  actorId: r.actor_id ?? undefined,
  tenantId: r.tenant_id ?? undefined,
  requestId: r.request_id ?? undefined,
  at: r.at,
})

type Bindable = null | number | string

export class SqliteAuditStore implements AuditStore {
  constructor(private readonly db: DatabaseSync) {}

  async append(entry: AuditEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit_entries (id, source, event, payload, actor_id, tenant_id, request_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.source,
        entry.event,
        entry.payload === undefined ? null : JSON.stringify(entry.payload),
        entry.actorId ?? null,
        entry.tenantId ?? null,
        entry.requestId ?? null,
        entry.at,
      )
  }

  async query(query: AuditQuery): Promise<AuditEntry[]> {
    // Exact filters — including an event name with no wildcard — push down to SQL,
    // and so does the limit. Only a wildcard pattern still needs matching in code,
    // and then rows are read in bounded LIMIT/OFFSET pages: a `limit: 50` query must
    // never SELECT the whole (unbounded) trail into memory.
    const where: string[] = []
    const args: Bindable[] = []
    if (query.tenantId !== undefined) {
      where.push('tenant_id = ?')
      args.push(query.tenantId)
    }
    if (query.actorId !== undefined) {
      where.push('actor_id = ?')
      args.push(query.actorId)
    }
    if (query.since !== undefined) {
      where.push('at >= ?')
      args.push(query.since)
    }
    const exact = exactEventMatch(query.event)
    if (exact !== undefined) {
      where.push('event = ?')
      args.push(exact)
    }
    const base =
      'SELECT * FROM audit_entries' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY at DESC, rowid DESC' // newest first, ties by insertion order

    const read = (limit: number | undefined, offset: number): AuditEntry[] => {
      const sql = limit === undefined ? base : `${base} LIMIT ${limit} OFFSET ${offset}`
      return (this.db.prepare(sql).all(...args) as unknown as AuditRow[]).map(toEntry)
    }

    if (query.event === undefined || exact !== undefined) return read(query.limit, 0)

    const pattern = query.event
    const out: AuditEntry[] = []
    for (let offset = 0; ; offset += AUDIT_SCAN_PAGE) {
      const page = read(AUDIT_SCAN_PAGE, offset)
      for (const entry of page) {
        if (!patternMatches(pattern, entry.event)) continue
        out.push(entry)
        if (query.limit !== undefined && out.length >= query.limit) return out
      }
      if (page.length < AUDIT_SCAN_PAGE) return out
    }
  }
}

export interface SqliteAuditStores {
  db: DatabaseSync
  store: SqliteAuditStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the audit store wired to
 * it, named to drop straight into `auditPlugin`:
 *
 * ```ts
 * const a = sqliteAuditStore('./data/audit.db')
 * auditPlugin({ store: a.store })
 * ```
 */
export function sqliteAuditStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteAuditStores {
  const db = typeof dbOrLocation === 'string' ? openAuditDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, store: new SqliteAuditStore(db) }
}
