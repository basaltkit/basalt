// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import { randomUUID } from 'node:crypto'
import type { OutboxEntry, OutboxStore } from '@basaltkit/events'

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
      last_error   TEXT
    );
    -- Partial index: the relay only ever scans un-published rows, oldest first.
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (created_at) WHERE published_at IS NULL;
  `)
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

  async enqueue(input: {
    id?: string
    event: string
    payload: unknown
    tenantId?: string
    createdAt: number
  }): Promise<OutboxEntry> {
    const id = input.id ?? randomUUID()
    const payload = input.payload === undefined ? null : JSON.stringify(input.payload)
    // INSERT OR REPLACE mirrors MemoryOutboxStore: re-enqueuing the same id
    // replaces the entry (attempts reset to 0, publish/error cleared).
    this.db
      .prepare(
        `INSERT OR REPLACE INTO outbox (id, event, payload, tenant_id, created_at, attempts, published_at, last_error)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
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

  async pending(limit: number, maxAttempts: number): Promise<OutboxEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE published_at IS NULL AND attempts < ?
         ORDER BY created_at ASC, rowid ASC
         LIMIT ?`,
      )
      .all(maxAttempts, limit) as unknown as OutboxRow[]
    return rows.map(toEntry)
  }

  async markPublished(id: string, at: number): Promise<void> {
    this.db.prepare('UPDATE outbox SET published_at = ? WHERE id = ?').run(at, id)
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(error, id)
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
