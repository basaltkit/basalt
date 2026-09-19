---
'@basaltkit/scheduler': minor
'@basaltkit/events': minor
'@basaltkit/events-prisma': minor
'@basaltkit/events-sqlite': minor
---

Stuck-work reconciliation and a real transactional outbox.

- `@basaltkit/scheduler`: `defineReconciler({ name, every, find, redispatch, maxPerRun?, onError?, onRun?, lock? })` — periodically finds items stuck in an intermediate state (dispatch failed after commit, worker died mid-job) and re-dispatches them. In-process overlap guard, `.onOneServer()` when the scheduler has a lock, optional whole-run distributed `ReconcilerLock`, per-item error isolation, `reconciler:run` hook + `stats` counters. `SchedulerOptions.hooks` (the plugin passes the app's bus); new `ScheduleDefinitionError` code `SCHEDULE_INVALID_INTERVAL`.
- `@basaltkit/events`: `Outbox.enqueue(event, payload, { tenantId?, tx? })` (or `tenantId, { tx }`) forwards the transaction handle to `OutboxStore.enqueue(entry, { tx })`, so the entry commits/rolls back with the state change. New optional `OutboxStore.claim(ids, { token, until, now })`: the relay claims a batch with a lease before dispatching, so several relays (replicas) never dispatch the same entry; `pending()` receives `filter.now` and `markFailed(id, error, { retryAt })` stores the retry backoff for every replica. New `claimLeaseMs` option (default 5 min). `MemoryOutboxStore` implements `claim`. Stores without `claim` behave as before.
- `@basaltkit/events-prisma`: `enqueue(entry, { tx })` writes through the Prisma interactive-transaction client. `prismaOutboxStore(prisma, { claim: true })` enables multi-replica claiming with one conditional `updateMany` (no raw SQL, tenancy raw-guard safe) — requires the new `lockedUntil` / `lockedBy` columns from the reference schema (opt-in so existing tables keep working).
- `@basaltkit/events-sqlite`: `enqueue(entry, { tx: db })` writes on the given `DatabaseSync`; claiming is always on (`migrate()` adds `locked_until` / `locked_by` to existing tables in place).
