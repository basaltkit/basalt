# @basaltkit/subscriptions-prisma

## 2.2.3

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/subscriptions@3.0.0

## 2.2.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 2.2.1

### Patch Changes

- 59cf29c: Lock the reference `schema.prisma` (and the README copy users actually paste) to the columns the stores write.
  
  `save()` writes every column of the subscription record on every call, including the `pendingPlan`/`pendingPeriod` fields the escalation guard clears by writing null. A reference schema missing any of them makes every save fail with an unknown-argument error on a database built by copying it. The schema is hand-maintained, so nothing but a test kept it in sync; there is now a test.

## 2.2.0

### Minor Changes

- 5b51958: Persist the `pendingPlan` / `pendingPeriod` fields backing `@basaltkit/subscriptions`' checkout-escalation guard.
  
  - **subscriptions-prisma:** the reference `schema.prisma` gains two optional columns (`pendingPlan String?`, `pendingPeriod String?`). **Action required:** re-sync your app schema (`basalt prisma:sync`) and run a migration; the store now always writes these columns, so an un-migrated database will fail loudly on save rather than silently mis-handling a plan change.
  - **subscriptions-sqlite:** columns are added automatically (`ALTER TABLE … ADD COLUMN` on open, tolerated when they already exist) — no action needed.

## 2.1.0

### Minor Changes

- Add durable **payment ledger + recurring** stores so apps stop hand-rolling
  them: `PrismaPaymentStore` (implements `PaymentStore`) and
  `PrismaRecurringStore` (implements `RecurringStore`), plus the
  `prismaPaymentStores(client)` factory. Money is stored as **`BigInt`** (minor
  units) to avoid the 32-bit `Int` ceiling; `create` uses an atomic
  `skipDuplicates` insert and `setStatus`/`save` fall back to an update on a
  concurrent unique-violation (P2002). New `Payment` and `RecurringSubscription`
  models in the bundled `prisma/schema.prisma`.

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
