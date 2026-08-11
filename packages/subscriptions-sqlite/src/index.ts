// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type {
  BillingPeriod,
  NewPayment,
  PaymentRecord,
  PaymentRecordStatus,
  PaymentStore,
  RecurringInterval,
  RecurringStatus,
  RecurringStore,
  RecurringSubscription,
  SubscriptionRecord,
  SubscriptionStatus,
  SubscriptionStore,
  UsageConsumeResult,
  UsageStore,
  WebhookStore,
} from '@basaltkit/subscriptions'

/**
 * Durable, SQLite-backed implementations of the three `@basaltkit/subscriptions`
 * stores — subscriptions, usage metering and webhook idempotency — on Node's
 * built-in `node:sqlite`. Zero external dependencies.
 *
 * The metered `consume()` is **atomic**: it runs inside a `BEGIN IMMEDIATE`
 * transaction and increments with a `RETURNING` guard, so a quota is never
 * overshot even under concurrent access (the same guarantee the Redis Lua store
 * gives, without Redis). The single-node reference backend; the production
 * (Postgres/MySQL) counterpart is `@basaltkit/subscriptions-prisma`.
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
  // Wait up to 5s for a competing writer's lock instead of throwing
  // 'database is locked' immediately — smooths over dev reloads / concurrency.
  db.exec('PRAGMA busy_timeout = 5000')
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

    CREATE TABLE IF NOT EXISTS payments (
      id          TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'pending',
      amount      INTEGER NOT NULL,
      billable_id TEXT,
      reference   TEXT,
      raw         TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_subscriptions (
      billable_id        TEXT PRIMARY KEY,
      plan               TEXT NOT NULL,
      amount             INTEGER NOT NULL,
      "interval"         TEXT NOT NULL,
      status             TEXT NOT NULL,
      paid_through       INTEGER,
      pending_payment_id TEXT,
      customer           TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
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

// --- payments ledger + recurring --------------------------------------------

interface PaymentRow {
  id: string
  status: string
  amount: number | bigint
  billable_id: string | null
  reference: string | null
  raw: string | null
  created_at: number
  updated_at: number
}
interface RecurringRow {
  billable_id: string
  plan: string
  amount: number | bigint
  interval: string
  status: string
  paid_through: number | null
  pending_payment_id: string | null
  customer: string | null
  created_at: number
  updated_at: number
}

/**
 * SQLite-backed `PaymentStore` — the payment ledger keyed by the gateway
 * payment id. `create` is an idempotent `INSERT OR IGNORE`; `setStatus` updates
 * in place (inserting if the payment was never recorded). Money is a 64-bit
 * `INTEGER` (minor units).
 */
export class SqlitePaymentStore implements PaymentStore {
  constructor(private readonly db: DatabaseSync) {}

  async create(payment: NewPayment): Promise<void> {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO payments (id, status, amount, billable_id, reference, raw, created_at, updated_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payment.id,
        payment.amount,
        orNull(payment.billableId),
        orNull(payment.reference),
        payment.raw !== undefined ? JSON.stringify(payment.raw) : null,
        now,
        now,
      )
  }

  async setStatus(
    id: string,
    status: PaymentRecordStatus,
    patch: { amount?: number; raw?: unknown } = {},
  ): Promise<void> {
    const now = Date.now()
    const sets = ['status = ?', 'updated_at = ?']
    const args: Bindable[] = [status, now]
    if (patch.amount != null) {
      sets.push('amount = ?')
      args.push(patch.amount)
    }
    if (patch.raw !== undefined) {
      sets.push('raw = ?')
      args.push(patch.raw !== null ? JSON.stringify(patch.raw) : null)
    }
    const updated = this.db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
    if (updated.changes === 0) {
      // Never recorded — insert it (OR IGNORE covers a concurrent create race).
      this.db
        .prepare(
          `INSERT OR IGNORE INTO payments (id, status, amount, raw, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, status, patch.amount ?? 0, patch.raw != null ? JSON.stringify(patch.raw) : null, now, now)
    }
  }

  async get(id: string): Promise<PaymentRecord | undefined> {
    const r = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as PaymentRow | undefined
    if (!r) return undefined
    const rec: PaymentRecord = {
      id: r.id,
      status: r.status as PaymentRecordStatus,
      amount: Number(r.amount),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
    if (r.billable_id !== null) rec.billableId = r.billable_id
    if (r.reference !== null) rec.reference = r.reference
    if (r.raw !== null) rec.raw = JSON.parse(r.raw)
    return rec
  }
}

const toRecurring = (r: RecurringRow): RecurringSubscription => {
  const sub: RecurringSubscription = {
    billableId: r.billable_id,
    plan: r.plan,
    amount: Number(r.amount),
    interval: r.interval as RecurringInterval,
    status: r.status as RecurringStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  if (r.paid_through !== null) sub.paidThrough = r.paid_through
  if (r.pending_payment_id !== null) sub.pendingPaymentId = r.pending_payment_id
  if (r.customer !== null) sub.customer = JSON.parse(r.customer)
  return sub
}

/** SQLite-backed `RecurringStore` — one recurring subscription per billableId. */
export class SqliteRecurringStore implements RecurringStore {
  constructor(private readonly db: DatabaseSync) {}

  async save(sub: RecurringSubscription): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO recurring_subscriptions
           (billable_id, plan, amount, "interval", status, paid_through, pending_payment_id, customer, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(billable_id) DO UPDATE SET
           plan = excluded.plan, amount = excluded.amount, "interval" = excluded."interval",
           status = excluded.status, paid_through = excluded.paid_through,
           pending_payment_id = excluded.pending_payment_id, customer = excluded.customer,
           updated_at = excluded.updated_at`,
      )
      .run(
        sub.billableId,
        sub.plan,
        sub.amount,
        sub.interval,
        sub.status,
        orNull(sub.paidThrough),
        orNull(sub.pendingPaymentId),
        sub.customer ? JSON.stringify(sub.customer) : null,
        sub.createdAt,
        sub.updatedAt,
      )
  }

  async get(billableId: string): Promise<RecurringSubscription | undefined> {
    const r = this.db
      .prepare('SELECT * FROM recurring_subscriptions WHERE billable_id = ?')
      .get(billableId) as RecurringRow | undefined
    return r ? toRecurring(r) : undefined
  }

  async list(): Promise<RecurringSubscription[]> {
    const rows = this.db
      .prepare('SELECT * FROM recurring_subscriptions ORDER BY billable_id ASC')
      .all() as unknown as RecurringRow[]
    return rows.map(toRecurring)
  }
}

export interface SqlitePaymentStores {
  db: DatabaseSync
  payments: SqlitePaymentStore
  recurring: SqliteRecurringStore
}

/**
 * Wire the payment ledger + recurring stores to a SQLite database:
 *
 * ```ts
 * const p = sqlitePaymentStores('./data/billing.db')
 * const ledger = new PaymentLedger({ store: p.payments, webhooks: s.webhooks })
 * const billing = new RecurringReferenceBilling({ gateway, ledger, store: p.recurring })
 * ```
 */
export function sqlitePaymentStores(
  dbOrLocation: DatabaseSync | string = ':memory:',
): SqlitePaymentStores {
  const db = typeof dbOrLocation === 'string' ? openSubscriptionsDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, payments: new SqlitePaymentStore(db), recurring: new SqliteRecurringStore(db) }
}
