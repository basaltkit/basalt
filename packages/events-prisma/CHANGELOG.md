# @basaltkit/events-prisma

## 1.2.0

### Minor Changes

- b0cc59f: Stuck-work reconciliation and a real transactional outbox.
  
  - `@basaltkit/scheduler`: `defineReconciler({ name, every, find, redispatch, maxPerRun?, onError?, onRun?, lock? })` — periodically finds items stuck in an intermediate state (dispatch failed after commit, worker died mid-job) and re-dispatches them. In-process overlap guard, `.onOneServer()` when the scheduler has a lock, optional whole-run distributed `ReconcilerLock`, per-item error isolation, `reconciler:run` hook + `stats` counters. `SchedulerOptions.hooks` (the plugin passes the app's bus); new `ScheduleDefinitionError` code `SCHEDULE_INVALID_INTERVAL`.
  - `@basaltkit/events`: `Outbox.enqueue(event, payload, { tenantId?, tx? })` (or `tenantId, { tx }`) forwards the transaction handle to `OutboxStore.enqueue(entry, { tx })`, so the entry commits/rolls back with the state change. New optional `OutboxStore.claim(ids, { token, until, now })`: the relay claims a batch with a lease before dispatching, so several relays (replicas) never dispatch the same entry; `pending()` receives `filter.now` and `markFailed(id, error, { retryAt })` stores the retry backoff for every replica. New `claimLeaseMs` option (default 5 min). `MemoryOutboxStore` implements `claim`. Stores without `claim` behave as before.
  - `@basaltkit/events-prisma`: `enqueue(entry, { tx })` writes through the Prisma interactive-transaction client. `prismaOutboxStore(prisma, { claim: true })` enables multi-replica claiming with one conditional `updateMany` (no raw SQL, tenancy raw-guard safe) — requires the new `lockedUntil` / `lockedBy` columns from the reference schema (opt-in so existing tables keep working).
  - `@basaltkit/events-sqlite`: `enqueue(entry, { tx: db })` writes on the given `DatabaseSync`; claiming is always on (`migrate()` adds `locked_until` / `locked_by` to existing tables in place).

## 1.1.0

### Minor Changes

- fb85c40: Security hardening, follow-ups to the outbox (F68) and SDK path-param (F73) fixes:
  
  - events: the outbox relay is fair across tenants, so a tenant whose downstream hangs cannot starve other tenants however many events it emits. When one tenant's backlog fills a page, `flush()` queries again with the tenants already seen excluded, then interleaves the batch round-robin by tenant (each tenant stays FIFO). New `OutboxOptions.tenantConcurrency` (default `ceil(concurrency / 2)`) caps one tenant's in-flight dispatches across flushes. New `dispatchTimeoutMs` (default 10 s, `false` to disable) bounds how long a flush waits on one dispatch. A slower dispatch keeps running detached: it is not cancelled or re-sent, its outcome is still recorded, and `FlushResult.detached` counts it. `OutboxStore.pending()` takes an optional `OutboxPendingFilter` (`excludeTenantIds`, `excludeGlobal`). Custom stores that ignore the filter still work, with fairness limited to one page. Single-tenant apps: tenant-less entries share one `tenantConcurrency` budget, so raise it to keep 8 parallel dispatches.
  - events-sqlite / events-prisma: `pending()` implements the tenant filter NULL-safely.
  - webhooks: `webhookOutboxPlugin` forwards `tenantConcurrency` and `dispatchTimeoutMs` and adds `onFlushError`. A store-level failure on a timer flush no longer becomes an unhandled rejection. `WebhookStore.forEvent(event)` with no tenant (`undefined`, `null` or `''`) is now fail-closed in `MemoryWebhookStore`, `SqliteWebhookStore` and `PrismaWebhookStore`: it returns tenant-agnostic endpoints only. `dispatch(..., { allTenants: true })` reads endpoints through `list()` instead.
  - sdk: a colon inside a path segment is literal again, so Google-style custom methods (`/v1/items:batch`, `/items/:id:archive`) work. Only a `:name` at the start of a segment is a placeholder, and `.`, `..`, empty or missing values are still refused with `CLIENT_INVALID_PARAM`.

## 1.0.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.0.5

### Initial release

- Prisma-backed `OutboxStore` for `@basaltkit/events` — the production
  (PostgreSQL/MySQL) counterpart to the in-memory `MemoryOutboxStore`. Bring your
  own `PrismaClient`; ships a reference `schema.prisma` (`OutboxEntry`),
  discoverable by `basalt prisma:sync`.
- `prismaOutboxStore(client)` returns a store ready for `outboxPlugin({ store })`,
  with `enqueue`/`pending`/`markPublished`/`markFailed`/`all`. Keeping the outbox
  in your primary database lets you enqueue events in the same transaction as the
  state change — at-least-once, crash-safe delivery. Fails fast when the client
  lacks the `OutboxEntry` model.
