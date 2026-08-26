<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/subscriptions-sqlite

Durable, **SQLite-backed** implementations of the three
[`@basaltkit/subscriptions`](https://github.com/basaltkit/basalt/tree/main/packages/subscriptions)
stores — the **subscription** record, **usage** metering and **webhook**
idempotency — built on Node's built-in
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

## Stores & tables

| Export | Contract | Table |
| --- | --- | --- |
| `SqliteSubscriptionStore` | `SubscriptionStore` | `subscriptions` |
| `SqliteUsageStore` | `UsageStore` (atomic `consume`) | `usage_counters` |
| `SqliteWebhookStore` | `WebhookStore` | `webhook_events` |

Each store is also exported on its own and takes a `DatabaseSync`, so it can
share a handle with the other `*-sqlite` stores. `openSubscriptionsDatabase()`
and `migrate()` are exported if you'd rather wire things up yourself.

## Notes

- **Schema** is created with `CREATE TABLE IF NOT EXISTS`, so `migrate()` is safe
  on every boot. WAL journaling is on.
- The durable **subscription record** is new — it had no non-memory backend
  before. (`@basaltkit/subscriptions` already shipped Redis usage/webhook stores.)
- `node:sqlite` is synchronous; the methods stay `async` to honor the contracts.

## License

MIT
