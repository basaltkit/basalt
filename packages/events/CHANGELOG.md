# @basaltkit/events

## 1.3.0

### Minor Changes

- b0cc59f: Stuck-work reconciliation and a real transactional outbox.
  
  - `@basaltkit/scheduler`: `defineReconciler({ name, every, find, redispatch, maxPerRun?, onError?, onRun?, lock? })` — periodically finds items stuck in an intermediate state (dispatch failed after commit, worker died mid-job) and re-dispatches them. In-process overlap guard, `.onOneServer()` when the scheduler has a lock, optional whole-run distributed `ReconcilerLock`, per-item error isolation, `reconciler:run` hook + `stats` counters. `SchedulerOptions.hooks` (the plugin passes the app's bus); new `ScheduleDefinitionError` code `SCHEDULE_INVALID_INTERVAL`.
  - `@basaltkit/events`: `Outbox.enqueue(event, payload, { tenantId?, tx? })` (or `tenantId, { tx }`) forwards the transaction handle to `OutboxStore.enqueue(entry, { tx })`, so the entry commits/rolls back with the state change. New optional `OutboxStore.claim(ids, { token, until, now })`: the relay claims a batch with a lease before dispatching, so several relays (replicas) never dispatch the same entry; `pending()` receives `filter.now` and `markFailed(id, error, { retryAt })` stores the retry backoff for every replica. New `claimLeaseMs` option (default 5 min). `MemoryOutboxStore` implements `claim`. Stores without `claim` behave as before.
  - `@basaltkit/events-prisma`: `enqueue(entry, { tx })` writes through the Prisma interactive-transaction client. `prismaOutboxStore(prisma, { claim: true })` enables multi-replica claiming with one conditional `updateMany` (no raw SQL, tenancy raw-guard safe) — requires the new `lockedUntil` / `lockedBy` columns from the reference schema (opt-in so existing tables keep working).
  - `@basaltkit/events-sqlite`: `enqueue(entry, { tx: db })` writes on the given `DatabaseSync`; claiming is always on (`migrate()` adds `locked_until` / `locked_by` to existing tables in place).

### Patch Changes

- Updated dependencies [b0cc59f]
  - @basaltkit/core@1.3.2

## 1.2.0

### Minor Changes

- fb85c40: Security hardening for webhooks and the outbox:
  
  - webhooks: a dispatch with no tenant now reaches only tenant-agnostic endpoints (explicit `{ allTenants: true }` for system fan-out); with tenancy active, `register`/`list`/`unregister` without a tenant throw `WebhookTenantRequiredError` unless `{ system: true }`; `list()` no longer returns signing secrets (`hasSecret` instead).
  - webhooks: the SSRF guard now classifies IPv6 addresses over their parsed bytes, so IPv4-mapped/compatible, NAT64, 6to4 and other special-purpose forms of private addresses are refused.
  - webhooks: tenant endpoints get their own generated signing secret (returned once by `register()`); tenant endpoints are never signed with the plugin-wide secret and deliveries are never sent unsigned by default (`allowSharedSecret` / `allowUnsigned` opt-outs); secrets under 16 characters are refused and `verifySignature` returns `false` for them; each delivery carries a signed unique `id` (`x-basalt-delivery`) and `endpointId`.
  - webhooks: delivery closes the connection once the response status is known instead of draining the body.
  - events: `Outbox` no longer lets entries in backoff occupy the batch, dispatches a batch with bounded parallelism (`concurrency`, default 8), and `MemoryOutboxStore` prunes old published entries (`retainPublished`, default 1000). `webhookOutboxPlugin` forwards `concurrency`.
- fb85c40: Security hardening, follow-ups to the outbox (F68) and SDK path-param (F73) fixes:
  
  - events: the outbox relay is fair across tenants, so a tenant whose downstream hangs cannot starve other tenants however many events it emits. When one tenant's backlog fills a page, `flush()` queries again with the tenants already seen excluded, then interleaves the batch round-robin by tenant (each tenant stays FIFO). New `OutboxOptions.tenantConcurrency` (default `ceil(concurrency / 2)`) caps one tenant's in-flight dispatches across flushes. New `dispatchTimeoutMs` (default 10 s, `false` to disable) bounds how long a flush waits on one dispatch. A slower dispatch keeps running detached: it is not cancelled or re-sent, its outcome is still recorded, and `FlushResult.detached` counts it. `OutboxStore.pending()` takes an optional `OutboxPendingFilter` (`excludeTenantIds`, `excludeGlobal`). Custom stores that ignore the filter still work, with fairness limited to one page. Single-tenant apps: tenant-less entries share one `tenantConcurrency` budget, so raise it to keep 8 parallel dispatches.
  - events-sqlite / events-prisma: `pending()` implements the tenant filter NULL-safely.
  - webhooks: `webhookOutboxPlugin` forwards `tenantConcurrency` and `dispatchTimeoutMs` and adds `onFlushError`. A store-level failure on a timer flush no longer becomes an unhandled rejection. `WebhookStore.forEvent(event)` with no tenant (`undefined`, `null` or `''`) is now fail-closed in `MemoryWebhookStore`, `SqliteWebhookStore` and `PrismaWebhookStore`: it returns tenant-agnostic endpoints only. `dispatch(..., { allTenants: true })` reads endpoints through `list()` instead.
  - sdk: a colon inside a path segment is literal again, so Google-style custom methods (`/v1/items:batch`, `/items/:id:archive`) work. Only a `:name` at the start of a segment is a placeholder, and `.`, `..`, empty or missing values are still refused with `CLIENT_INVALID_PARAM`.

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.1.0

### Minor Changes

- cc4786e: **Outbox: the at-least-once contract is now real (Q-5).**
  
  **What was broken.** Automatic capture was fire-and-forget (`void enqueue(...)`) — a transient store-write failure dropped the event silently while the module promises "nothing is lost". The interval flush had no overlap guard, so a slow dispatch let the next tick re-select the same batch: double delivery. `markFailed` scheduled no backoff (failed entries were hammered every tick), an entry exhausting `maxAttempts` vanished from flushes with no signal, and a store fault inside the timer was an unhandled rejection.
  
  **What changed.** Capture is awaited — a failed outbox write now fails the `emit()` (the EventBus aggregates listener errors), which is the transactional-outbox contract. Concurrent `flush()` calls coalesce onto the in-flight flush. Failed entries retry with exponential backoff (new `backoff` option, default 1 s doubling capped at 60 s; tracked per relay process — no store/schema change, a restart merely allows one immediate retry). Entries that exhaust `maxAttempts` are reported once through the new `onDead` callback (default `console.error`) and stay in the store with their `lastError`. Timer/shutdown flush faults route to the new `onFlushError` plugin option instead of crashing.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0

## 0.3.0

### Minor Changes

- 7b92e25: Reliability & tracing:

  - `@basaltkit/events`: transactional **outbox** for at-least-once delivery to external systems — `Outbox`, `MemoryOutboxStore`, `outboxPlugin` (capture domain events tenant-scoped, relay on an interval with retry/backoff and a dead-letter ceiling).
  - `@basaltkit/core`: dependency-free **distributed tracing** — W3C trace-context (`parseTraceparent`/`formatTraceparent`), `Tracer`/`Span`, and an **OTLP/HTTP JSON exporter** that talks to any OpenTelemetry collector (`OtlpHttpExporter`), plus `ConsoleSpanExporter`/`InMemorySpanExporter`.
  - `@basaltkit/fastify`: `tracingPlugin` — continues an inbound trace, records a server span per request (labelled by route template) with HTTP attributes and status, echoes `traceparent`, and exports.

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
