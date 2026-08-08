// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type {
  BillingPeriod,
  SubscriptionRecord,
  SubscriptionStatus,
  SubscriptionStore,
  UsageConsumeResult,
  UsageStore,
  WebhookStore,
} from '@machize/subscriptions'

/**
 * Durable, SQLite-backed implementations of the three `@machize/subscriptions`
 * stores — subscriptions, usage metering and webhook idempotency — on Node's
 * built-in `node:sqlite`. Zero external dependencies.
 *
 * The metered `consume()` is **atomic**: it runs inside a `BEGIN IMMEDIATE`
 * transaction and increments with a `RETURNING` guard, so a quota is never
 * overshot even under concurrent access (the same guarantee the Redis Lua store
 * gives, without Redis). The single-node reference backend; the production
 * (Postgres/MySQL) counterpart is `@machize/subscriptions-prisma`.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

type Bindable = null | number | bigint | string | Uint8Array
const bool = (v: boolean): number => (v ? 1 : 0)
const orNull = <T extends Bindable>(v: T | undefined): T | null => (v === undefined ? null : v)

/** Open (or create) a subscriptions database and apply the schema. */
export function openSubscriptionsDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location)
  migrate(db)
  return db
}

/** Idempotent schema — safe to run on every open. */
export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      billable_id          TEXT PRIMARY KEY,
      plan                 TEXT NOT NULL,
      period               TEXT NOT NULL,
      status               TEXT NOT NULL,
      trial_ends_at        INTEGER,
      cancel_at_period_end INTEGER,
      canceled_at          INTEGER,
      gateway_ref          TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_counters (
      billable_id TEXT NOT NULL,
      feature     TEXT NOT NULL,
      period_key  TEXT NOT NULL,
      value       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (billable_id, feature, period_key)
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id      TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );
  `)
}

// --- subscriptions ----------------------------------------------------------

interface SubscriptionRow {
  billable_id: string
  plan: string
  period: string
  status: string
  trial_ends_at: number | null
  cancel_at_period_end: number | null
  canceled_at: number | null
  gateway_ref: string | null
}

const toSubscription = (r: SubscriptionRow): SubscriptionRecord => {
  const rec: SubscriptionRecord = {
    billableId: r.billable_id,
    plan: r.plan,
    period: r.period as BillingPeriod,
    status: r.status as SubscriptionStatus,
  }
  if (r.trial_ends_at !== null) rec.trialEndsAt = r.trial_ends_at
  if (r.cancel_at_period_end !== null) rec.cancelAtPeriodEnd = r.cancel_at_period_end === 1
  if (r.canceled_at !== null) rec.canceledAt = r.canceled_at
  if (r.gateway_ref !== null) rec.gatewayRef = r.gateway_ref
  return rec
}

export class SqliteSubscriptionStore implements SubscriptionStore {
  constructor(private readonly db: DatabaseSync) {}

  async get(billableId: string): Promise<SubscriptionRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM subscriptions WHERE billable_id = ?')
      .get(billableId) as SubscriptionRow | undefined
    return row ? toSubscription(row) : null
  }

  async save(record: SubscriptionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (billable_id, plan, period, status, trial_ends_at, cancel_at_period_end, canceled_at, gateway_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(billable_id) DO UPDATE SET
           plan = excluded.plan, period = excluded.period, status = excluded.status,
           trial_ends_at = excluded.trial_ends_at, cancel_at_period_end = excluded.cancel_at_period_end,
           canceled_at = excluded.canceled_at, gateway_ref = excluded.gateway_ref`,
      )
      .run(
        record.billableId,
        record.plan,
        record.period,
        record.status,
        orNull(record.trialEndsAt),
        record.cancelAtPeriodEnd === undefined ? null : bool(record.cancelAtPeriodEnd),
        orNull(record.canceledAt),
        orNull(record.gatewayRef),
      )
  }

  async all(): Promise<SubscriptionRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM subscriptions ORDER BY billable_id')
      .all() as unknown as SubscriptionRow[]
    return rows.map(toSubscription)
  }
}

// --- webhook idempotency ----------------------------------------------------

export class SqliteWebhookStore implements WebhookStore {
  constructor(private readonly db: DatabaseSync) {}

  async markProcessed(id: string): Promise<boolean> {
    // Single atomic INSERT; a duplicate id is ignored and reported as "seen".
    const info = this.db
      .prepare('INSERT OR IGNORE INTO webhook_events (id, seen_at) VALUES (?, ?)')
      .run(id, Date.now())
    return info.changes === 1
  }

  async release(id: string): Promise<void> {
    this.db.prepare('DELETE FROM webhook_events WHERE id = ?').run(id)
  }
}

// --- usage metering ---------------------------------------------------------

interface ValueRow {
  value: number
}

export class SqliteUsageStore implements UsageStore {
  constructor(private readonly db: DatabaseSync) {}

  async get(billableId: string, feature: string, periodKey: string): Promise<number> {
    const row = this.db
      .prepare('SELECT value FROM usage_counters WHERE billable_id = ? AND feature = ? AND period_key = ?')
      .get(billableId, feature, periodKey) as ValueRow | undefined
    return row?.value ?? 0
  }

  async increment(billableId: string, feature: string, periodKey: string, amount: number): Promise<number> {
    const row = this.db
      .prepare(
        `INSERT INTO usage_counters (billable_id, feature, period_key, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(billable_id, feature, period_key) DO UPDATE SET value = value + ?
         RETURNING value`,
      )
      .get(billableId, feature, periodKey, amount, amount) as unknown as ValueRow
    return row.value
  }

  async consume(
    billableId: string,
    feature: string,
    periodKey: string,
    amount: number,
    limit: number,
  ): Promise<UsageConsumeResult> {
    // BEGIN IMMEDIATE takes the write lock up front, so the read-check-write is
    // atomic across connections — no concurrent caller can overshoot the limit.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO usage_counters (billable_id, feature, period_key, value) VALUES (?, ?, ?, 0)')
        .run(billableId, feature, periodKey)
      const updated = this.db
        .prepare(
          `UPDATE usage_counters SET value = value + ?
           WHERE billable_id = ? AND feature = ? AND period_key = ? AND value + ? <= ?
           RETURNING value`,
        )
        .get(amount, billableId, feature, periodKey, amount, limit) as ValueRow | undefined
      let result: UsageConsumeResult
      if (updated) {
        result = { applied: true, used: updated.value }
      } else {
        const current = this.db
          .prepare('SELECT value FROM usage_counters WHERE billable_id = ? AND feature = ? AND period_key = ?')
          .get(billableId, feature, periodKey) as ValueRow | undefined
        result = { applied: false, used: current?.value ?? 0 }
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

// --- convenience ------------------------------------------------------------

export interface SqliteSubscriptionsStores {
  db: DatabaseSync
  store: SqliteSubscriptionStore
  usage: SqliteUsageStore
  webhooks: SqliteWebhookStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return all three stores wired
 * to it, named to drop straight into `subscriptionsPlugin`:
 *
 * ```ts
 * const s = sqliteSubscriptionsStores('./data/billing.db')
 * subscriptionsPlugin({ plans, store: s.store, usage: s.usage, webhooks: s.webhooks })
 * ```
 */
export function sqliteSubscriptionsStores(
  dbOrLocation: DatabaseSync | string = ':memory:',
): SqliteSubscriptionsStores {
  const db = typeof dbOrLocation === 'string' ? openSubscriptionsDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return {
    db,
    store: new SqliteSubscriptionStore(db),
    usage: new SqliteUsageStore(db),
    webhooks: new SqliteWebhookStore(db),
  }
}
