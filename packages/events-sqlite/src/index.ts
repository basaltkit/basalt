// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import { randomUUID } from 'node:crypto'
import type {
  OutboxClaimOptions,
  OutboxEntry,
  OutboxMarkFailedOptions,
  OutboxPendingFilter,
  OutboxStore,
} from '@basaltkit/events'

/**
 * Durable, SQLite-backed implementation of the `@basaltkit/events` `OutboxStore`,
 * on Node's built-in `node:sqlite`. Zero external dependencies. The single-node
 * reference backend for the transactional outbox; the production
 * (Postgres/MySQL) counterpart is `@basaltkit/events-prisma`.
 *
 * The whole point of the outbox is to survive a crash between "committed" and
 * "delivered" — so its store must be durable. `MemoryOutboxStore` (the default)
 * loses every un-relayed event on restart; this one doesn't.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

export function openOutboxDatabase(location = ':memory:'): DatabaseSync {
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
    CREATE TABLE IF NOT EXISTS outbox (
      id           TEXT PRIMARY KEY,
      event        TEXT NOT NULL,
      payload      TEXT,
      tenant_id    TEXT,
      created_at   INTEGER NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      published_at INTEGER,
      last_error   TEXT,
      locked_until INTEGER,
      locked_by    TEXT
    );
    -- Partial index: the relay only ever scans un-published rows, oldest first.
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (created_at) WHERE published_at IS NULL;
  `)
  // Tables created before the relay claim columns existed: add them in place.
  const columns = new Set(
    (db.prepare('PRAGMA table_info(outbox)').all() as unknown as { name: string }[]).map((c) => c.name),
  )
  if (!columns.has('locked_until')) db.exec('ALTER TABLE outbox ADD COLUMN locked_until INTEGER')
  if (!columns.has('locked_by')) db.exec('ALTER TABLE outbox ADD COLUMN locked_by TEXT')
}

interface OutboxRow {
  id: string
  event: string
  payload: string | null
  tenant_id: string | null
  created_at: number
  attempts: number
  published_at: number | null
  last_error: string | null
  locked_until: number | null
  locked_by: string | null
}

const toEntry = (r: OutboxRow): OutboxEntry => ({
  id: r.id,
  event: r.event,
  payload: r.payload === null ? undefined : (JSON.parse(r.payload) as unknown),
  createdAt: r.created_at,
  attempts: r.attempts,
  ...(r.tenant_id !== null ? { tenantId: r.tenant_id } : {}),
  ...(r.published_at !== null ? { publishedAt: r.published_at } : {}),
  ...(r.last_error !== null ? { lastError: r.last_error } : {}),
})

export class SqliteOutboxStore implements OutboxStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Writes the entry. Pass `{ tx }` — the `DatabaseSync` handle on which your
   * `BEGIN … COMMIT` runs (the store's own handle, or another connection to the
   * same file) — to write it in that transaction: a rollback removes it with the
   * state change. Without `tx` it is written on the store's handle, which already
   * joins any transaction open on that same handle.
   */
  async enqueue(
    input: {
      id?: string
      event: string
      payload: unknown
      tenantId?: string
      createdAt: number
    },
    options: { tx?: DatabaseSync } = {},
  ): Promise<OutboxEntry> {
    const id = input.id ?? randomUUID()
    const payload = input.payload === undefined ? null : JSON.stringify(input.payload)
    // INSERT OR REPLACE mirrors MemoryOutboxStore: re-enqueuing the same id
    // replaces the entry (attempts reset to 0, publish/error cleared).
    ;(options.tx ?? this.db)
      .prepare(
        `INSERT OR REPLACE INTO outbox (id, event, payload, tenant_id, created_at, attempts, published_at, last_error, locked_until, locked_by)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)`,
      )
      .run(id, input.event, payload, input.tenantId ?? null, input.createdAt)
    return {
      id,
      event: input.event,
      payload: input.payload,
      createdAt: input.createdAt,
      attempts: 0,
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    }
  }

  async pending(limit: number, maxAttempts: number, filter: OutboxPendingFilter = {}): Promise<OutboxEntry[]> {
    // Tenant exclusion (relay fairness): a NULL tenant_id never matches NOT IN,
    // so tenant-less rows are kept or dropped explicitly by `excludeGlobal`.
    const excluded = filter.excludeTenantIds ?? []
    const args: (string | number)[] = [maxAttempts]
    let tenantClause = ''
    if (excluded.length > 0) {
      const notIn = `tenant_id NOT IN (${excluded.map(() => '?').join(', ')})`
      tenantClause = filter.excludeGlobal ? ` AND ${notIn}` : ` AND (tenant_id IS NULL OR ${notIn})`
      args.push(...excluded)
    } else if (filter.excludeGlobal) {
      tenantClause = ' AND tenant_id IS NOT NULL'
    }
    if (filter.now !== undefined) {
      // Hide rows another relay holds, or that sit in a stored retry backoff.
      tenantClause += ' AND (locked_until IS NULL OR locked_until <= ?)'
      args.push(filter.now)
    }
    args.push(limit)
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE published_at IS NULL AND attempts < ?${tenantClause}
         ORDER BY created_at ASC, rowid ASC
         LIMIT ?`,
      )
      .all(...args) as unknown as OutboxRow[]
    return rows.map(toEntry)
  }

  /**
   * Claims rows for one relay: a single conditional UPDATE (atomic in SQLite,
   * also across processes sharing the file) stamps the token on rows still
   * unpublished and unclaimed (or expired); a SELECT reads back the winners.
   */
  async claim(ids: string[], options: OutboxClaimOptions): Promise<string[]> {
    if (ids.length === 0) return []
    const list = ids.map(() => '?').join(', ')
    this.db
      .prepare(
        `UPDATE outbox SET locked_until = ?, locked_by = ?
         WHERE id IN (${list}) AND published_at IS NULL AND (locked_until IS NULL OR locked_until <= ?)`,
      )
      .run(options.until, options.token, ...ids, options.now)
    const rows = this.db
      .prepare(`SELECT id FROM outbox WHERE locked_by = ? AND id IN (${list})`)
      .all(options.token, ...ids) as unknown as { id: string }[]
    const won = new Set(rows.map((row) => row.id))
    return ids.filter((id) => won.has(id))
  }

  async markPublished(id: string, at: number): Promise<void> {
    this.db
      .prepare('UPDATE outbox SET published_at = ?, locked_until = NULL, locked_by = NULL WHERE id = ?')
      .run(at, id)
  }

  /** Records a failure and releases the claim — or holds it until `retryAt` (cross-relay backoff). */
  async markFailed(id: string, error: string, options: OutboxMarkFailedOptions = {}): Promise<void> {
    this.db
      .prepare(
        'UPDATE outbox SET attempts = attempts + 1, last_error = ?, locked_until = ?, locked_by = NULL WHERE id = ?',
      )
      .run(error, options.retryAt ?? null, id)
  }

  async all(): Promise<OutboxEntry[]> {
    const rows = this.db
      .prepare('SELECT * FROM outbox ORDER BY created_at ASC, rowid ASC')
      .all() as unknown as OutboxRow[]
    return rows.map(toEntry)
  }
}

export interface SqliteOutboxStores {
  db: DatabaseSync
  store: SqliteOutboxStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the outbox store wired
 * to it, named to drop straight into `outboxPlugin`:
 *
 * ```ts
 * const outbox = sqliteOutboxStore('./data/outbox.db')
 * outboxPlugin({ store: outbox.store, dispatch, captureEvents: ['order.*'], intervalMs: 1000 })
 * ```
 */
export function sqliteOutboxStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteOutboxStores {
  const db = typeof dbOrLocation === 'string' ? openOutboxDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, store: new SqliteOutboxStore(db) }
}
