# @basaltkit/subscriptions-prisma

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

## 1.0.4

### Patch Changes

- Fail fast with an actionable error when the Prisma client is missing the models this package needs (previously a cryptic "reading create of undefined") — points to `basalt prisma:sync` or the reference schema. Lazy/proxy clients (database-per-tenant) are tolerated.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.32.0

### Patch Changes

- Fix a concurrency bug in `UsageStore.consume`/`increment`: the counter row was
  seeded with `upsert`, which races to INSERT and fails with Prisma `P2002` under
  concurrent first-touch on a real database. Now seeded with
  `createMany({ skipDuplicates: true })`, so concurrent callers are safe. Surfaced
  by the new PostgreSQL integration tests.

## 0.28.0

### Minor Changes

- Initial release. Prisma-backed implementations of the three
  `@basaltkit/subscriptions` stores — subscriptions, usage metering and webhook
  idempotency — for production databases (PostgreSQL/MySQL). The metered
  `consume()` is atomic (a conditional `updateMany` serialized by the database's
  row lock), so a quota is never overshot under concurrency.
  `prismaSubscriptionsStores(prisma)` returns all three stores named to drop
  straight into `subscriptionsPlugin`. Ships a reference `schema.prisma`. The
  production counterpart to `@basaltkit/subscriptions-sqlite`.
