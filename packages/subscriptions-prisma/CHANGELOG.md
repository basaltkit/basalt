# @machize/subscriptions-prisma

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
