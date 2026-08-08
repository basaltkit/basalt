# @machize/subscriptions-sqlite

## 0.28.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementations of the three
  `@machize/subscriptions` stores — subscriptions, usage metering and webhook
  idempotency — on Node's built-in `node:sqlite`, with zero external
  dependencies. The metered `consume()` is atomic (a `BEGIN IMMEDIATE`
  transaction with a `RETURNING` guard), so a quota is never overshot under
  concurrency. `sqliteSubscriptionsStores(location)` returns all three stores
  named to drop straight into `subscriptionsPlugin`. The single-node counterpart
  to `@machize/subscriptions-prisma`.
