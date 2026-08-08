# @machize/subscriptions-prisma

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

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
  `@machize/subscriptions` stores — subscriptions, usage metering and webhook
  idempotency — for production databases (PostgreSQL/MySQL). The metered
  `consume()` is atomic (a conditional `updateMany` serialized by the database's
  row lock), so a quota is never overshot under concurrency.
  `prismaSubscriptionsStores(prisma)` returns all three stores named to drop
  straight into `subscriptionsPlugin`. Ships a reference `schema.prisma`. The
  production counterpart to `@machize/subscriptions-sqlite`.
