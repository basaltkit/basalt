<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/subscriptions-sqlite

Durable, **SQLite-backed** implementations of every
[`@basaltkit/subscriptions`](https://github.com/basaltkit/basalt/tree/main/packages/subscriptions)
store — the **subscription** record, **usage** metering, **webhook** idempotency, the
**payment ledger** and **recurring** subscriptions — built on Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html). **Zero external
dependencies.**

`@basaltkit/subscriptions` ships in-memory stores that forget everything on
restart. Swap in these and billing state survives a redeploy — no ORM, no
migration tool, no service. The single-node reference backend; the production
(Postgres/MySQL) counterpart is
[`@basaltkit/subscriptions-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/subscriptions-prisma).

```bash
pnpm add @basaltkit/subscriptions-sqlite   # peer: @basaltkit/subscriptions
```

> Requires **Node 22.5+**. Stable and flag-free on Node 24; on 22.x run with
> `--experimental-sqlite`.

## Use it

`sqliteSubscriptionsStores()` opens (or creates) the database, applies the
schema, and returns all three stores named to drop straight into
`subscriptionsPlugin`:

```ts
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { sqliteSubscriptionsStores } from '@basaltkit/subscriptions-sqlite'

const s = sqliteSubscriptionsStores('./data/billing.db')   // ':memory:' by default

const app = await createApp({
  plugins: [
    subscriptionsPlugin({ plans, store: s.store, usage: s.usage, webhooks: s.webhooks }),
  ],
}).boot()
```

## Atomic usage metering

The metered `consume()` runs inside a `BEGIN IMMEDIATE` transaction and
increments with a `RETURNING` guard, so a plan quota is **never overshot even
under concurrent access** — the same guarantee the Redis Lua store gives,
without Redis. Webhook idempotency is a single atomic `INSERT OR IGNORE`, so a
redelivered event is processed once, across restarts and instances.

## Payment ledger & recurring billing

The reference-based recurring flow (`PaymentLedger` + `RecurringReferenceBilling` in
`@basaltkit/subscriptions`) gets durable stores from the same database:

```ts
import { PaymentLedger, RecurringReferenceBilling } from '@basaltkit/subscriptions'
import { sqlitePaymentStores, sqliteSubscriptionsStores } from '@basaltkit/subscriptions-sqlite'

const s = sqliteSubscriptionsStores('./data/billing.db')
const p = sqlitePaymentStores(s.db)                       // reuse the handle

const ledger = new PaymentLedger({ store: p.payments, webhooks: s.webhooks })
const billing = new RecurringReferenceBilling({ gateway, ledger, store: p.recurring })
```

Money is stored as a 64-bit SQLite `INTEGER` in **minor units** — no float, no 32-bit
ceiling. `SqlitePaymentStore.create` is an idempotent `INSERT OR IGNORE`, and `setStatus`
inserts if the payment was never recorded (so a webhook that arrives before the local
record still settles).

## Stores & tables

| Export | Contract | Table |
| --- | --- | --- |
| `SqliteSubscriptionStore` | `SubscriptionStore` | `subscriptions` |
| `SqliteUsageStore` | `UsageStore` (atomic `consume`) | `usage_counters` |
| `SqliteWebhookStore` | `WebhookStore` | `webhook_events` |
| `SqlitePaymentStore` | `PaymentStore` | `payments` |
| `SqliteRecurringStore` | `RecurringStore` | `recurring_subscriptions` |

Each store is also exported on its own and takes a `DatabaseSync`, so it can
share a handle with the other `*-sqlite` stores.

## API reference

| Export | Signature | Purpose |
| --- | --- | --- |
| `openSubscriptionsDatabase` | `(location?: string) => DatabaseSync` | Opens (or creates) the database and applies the schema. `location` defaults to `':memory:'`. |
| `migrate` | `(db: DatabaseSync) => void` | Applies the idempotent schema to a handle you already own. |
| `sqliteSubscriptionsStores` | `(dbOrLocation?: DatabaseSync \| string) => SqliteSubscriptionsStores` | `{ db, store, usage, webhooks }`, named to drop straight into `subscriptionsPlugin`. Default `':memory:'`. Passing a handle migrates it. |
| `sqlitePaymentStores` | `(dbOrLocation?: DatabaseSync \| string) => SqlitePaymentStores` | `{ db, payments, recurring }` for `PaymentLedger` / `RecurringReferenceBilling`. |

Both convenience functions accept either a path (they open it) or an existing
`DatabaseSync` (they migrate it and reuse it) — pass `s.db` to the second one so all five
tables live in one file and one connection.

## Notes

- **Schema** is created with `CREATE TABLE IF NOT EXISTS`, so `migrate()` is safe on every
  boot. WAL journaling is on, and `busy_timeout` is `5000` ms so a competing writer waits
  instead of throwing `database is locked` immediately.
- `migrate()` also `ALTER TABLE … ADD COLUMN`s `pending_plan` / `pending_period` onto
  databases created before the checkout-escalation guard landed; the error when the column
  already exists is swallowed. Upgrading is a restart, not a migration script.
- `node:sqlite` is synchronous; the methods stay `async` to honor the contracts.
- Single node by design. Two processes on the same file will serialize on the write lock;
  for real horizontal scale use `@basaltkit/subscriptions-prisma` or the Redis stores.

## Failure modes

This package defines no error classes — failures surface as `node:sqlite` errors, and
domain errors come from `@basaltkit/subscriptions` (`BILLING_QUOTA_EXCEEDED`, …).

- **`Cannot find module 'node:sqlite'`** — Node older than 22.5. Upgrade, or use the Prisma
  stores.
- **`database is locked` despite the busy timeout** — a long-running external transaction
  holds the write lock; SQLite is single-writer.
- **A quota looks overshot** — you're on `MemoryUsageStore` somewhere, or two databases.
  `SqliteUsageStore.consume` takes `BEGIN IMMEDIATE` before the read-check-write, so it
  cannot overshoot on one file.
- **Webhook processed twice** — two different database files (one per process). Point them
  at the same one.

Guides: [Billing](/guide/billing) · [Payment references](/guide/reference-payments) · [Persistence](/guide/persistence)

## License

MIT
