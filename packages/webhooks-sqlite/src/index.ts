// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import { randomUUID } from 'node:crypto'
import { matchesEvent, type WebhookEndpoint, type WebhookStore } from '@machize/webhooks'

/**
 * Durable, SQLite-backed implementation of the `@machize/webhooks` `WebhookStore`
 * (the outbound endpoint subscriptions), on Node's built-in `node:sqlite`. Zero
 * external dependencies. The single-node reference backend; the production
 * (Postgres/MySQL) counterpart is `@machize/webhooks-prisma`.
 *
 * `MemoryWebhookStore` (the default) forgets every registered endpoint on
 * restart — so after a redeploy, nothing is subscribed. This one persists them.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

export function openWebhooksDatabase(location = ':memory:'): DatabaseSync {
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
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id        TEXT PRIMARY KEY,
      url       TEXT NOT NULL,
      events    TEXT NOT NULL,
      tenant_id TEXT,
      secret    TEXT,
      active    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_tenant ON webhook_endpoints (tenant_id);
  `)
}

interface EndpointRow {
  id: string
  url: string
  events: string
  tenant_id: string | null
  secret: string | null
  active: number | null
}

const toEndpoint = (r: EndpointRow): WebhookEndpoint => ({
  id: r.id,
  url: r.url,
  events: JSON.parse(r.events) as string[],
  ...(r.tenant_id !== null ? { tenantId: r.tenant_id } : {}),
  ...(r.secret !== null ? { secret: r.secret } : {}),
  ...(r.active !== null ? { active: r.active === 1 } : {}),
})

export class SqliteWebhookStore implements WebhookStore {
  constructor(private readonly db: DatabaseSync) {}

  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> {
    // Narrow in SQL to active endpoints for this tenant (or tenant-agnostic ones);
    // the event-pattern match (`*`, `prefix.*`, exact) is applied in JS.
    let sql = 'SELECT * FROM webhook_endpoints WHERE (active IS NULL OR active = 1)'
    const args: string[] = []
    if (tenantId !== undefined) {
      sql += ' AND (tenant_id IS NULL OR tenant_id = ?)'
      args.push(tenantId)
    }
    const rows = this.db.prepare(sql).all(...args) as unknown as EndpointRow[]
    return rows.map(toEndpoint).filter((endpoint) => matchesEvent(endpoint.events, event))
  }

  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> {
    const id = endpoint.id ?? randomUUID()
    const record: WebhookEndpoint = { ...endpoint, id }
    // INSERT OR REPLACE mirrors MemoryWebhookStore: re-adding the same id replaces it.
    this.db
      .prepare(
        `INSERT OR REPLACE INTO webhook_endpoints (id, url, events, tenant_id, secret, active)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.url,
        JSON.stringify(record.events),
        record.tenantId ?? null,
        record.secret ?? null,
        record.active === undefined ? null : record.active ? 1 : 0,
      )
    return record
  }

  async remove(id: string): Promise<void> {
    this.db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(id)
  }

  async list(tenantId?: string): Promise<WebhookEndpoint[]> {
    let sql = 'SELECT * FROM webhook_endpoints'
    const args: string[] = []
    if (tenantId !== undefined) {
      sql += ' WHERE tenant_id = ?'
      args.push(tenantId)
    }
    sql += ' ORDER BY id'
    const rows = this.db.prepare(sql).all(...args) as unknown as EndpointRow[]
    return rows.map(toEndpoint)
  }
}

export interface SqliteWebhooksStores {
  db: DatabaseSync
  store: SqliteWebhookStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the webhook store wired
 * to it, named to drop straight into `webhooksPlugin`:
 *
 * ```ts
 * const webhooks = sqliteWebhookStore('./data/webhooks.db')
 * webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
 * ```
 */
export function sqliteWebhookStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteWebhooksStores {
  const db = typeof dbOrLocation === 'string' ? openWebhooksDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, store: new SqliteWebhookStore(db) }
}
