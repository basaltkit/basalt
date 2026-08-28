# @basaltkit/subscriptions-sqlite

## 2.2.0

### Minor Changes

- 5b51958: Persist the `pendingPlan` / `pendingPeriod` fields backing `@basaltkit/subscriptions`' checkout-escalation guard.
  
  - **subscriptions-prisma:** the reference `schema.prisma` gains two optional columns (`pendingPlan String?`, `pendingPeriod String?`). **Action required:** re-sync your app schema (`basalt prisma:sync`) and run a migration; the store now always writes these columns, so an un-migrated database will fail loudly on save rather than silently mis-handling a plan change.
  - **subscriptions-sqlite:** columns are added automatically (`ALTER TABLE … ADD COLUMN` on open, tolerated when they already exist) — no action needed.

## 2.1.0

### Minor Changes

- Add durable **payment ledger + recurring** stores (parity with
  `@basaltkit/subscriptions-prisma`): `SqlitePaymentStore` (`PaymentStore`) and
  `SqliteRecurringStore` (`RecurringStore`), plus the `sqlitePaymentStores()`
  factory. `create` is an idempotent `INSERT OR IGNORE`; money is a 64-bit
  `INTEGER` (minor units). New `payments` and `recurring_subscriptions` tables in
  the migration.

## 2.0.0

### Major Changes

- Move to `@basaltkit/subscriptions@2.0` (money in minor units). No code changes
  in this package — the store interfaces it implements are unchanged; the major
  bump only widens the peer range to `^2.0.0`.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.2

### Patch Changes

- Add `PRAGMA busy_timeout = 5000` so a write waits for a competing writer's
  lock (up to 5s) instead of throwing `database is locked` immediately. Prevents
  spurious 500s under dev auto-reload (`tsx watch`) or concurrent writers.

## 1.0.1

### Patch Changes

- Fix a runtime crash when consumed from the published package: the bundler
  stripped the `node:` prefix from the `node:sqlite` import, emitting a broken
  `from "sqlite"` that failed with `ERR_MODULE_NOT_FOUND: Cannot find package 'sqlite'`.
  The builtin is now loaded through an opaque specifier the bundler leaves intact.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.28.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementations of the three
  `@basaltkit/subscriptions` stores — subscriptions, usage metering and webhook
  idempotency — on Node's built-in `node:sqlite`, with zero external
  dependencies. The metered `consume()` is atomic (a `BEGIN IMMEDIATE`
  transaction with a `RETURNING` guard), so a quota is never overshot under
  concurrency. `sqliteSubscriptionsStores(location)` returns all three stores
  named to drop straight into `subscriptionsPlugin`. The single-node counterpart
  to `@basaltkit/subscriptions-prisma`.
