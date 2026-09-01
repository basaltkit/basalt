# @basaltkit/queue

## 2.1.1

### Patch Changes

- 23610df: Docs: make it explicit that `@basaltkit/queue` is required whichever backend you
  pick.
  
  The install table listed `Sync (dev/test) | @basaltkit/queue` as one row among
  the backends, which reads as "pick one" — so the core looked like an *option*
  rather than the contract every backend implements. A maintainer following it
  after the BullMQ extraction asked, reasonably, whether `@basaltkit/queue` was
  still needed at all.
  
  It is: `defineJob`, `dispatch`, the `QUEUE` token, `QueueManager`, workers and
  context propagation all live there, and a backend package **depends on** it
  rather than replacing it. Adding one chooses where jobs run; it does not swap
  libraries.
  
  The guide and the README now split "what comes from the core" from "what comes
  from a backend" before the table, and the sync row reads **none — inline,
  dev/tests** instead of naming the core as if it were a backend.
  
  Docs only — no code change.

## 2.1.0

### Minor Changes

- 4586ff4: ## ⚠️ THIS MINOR CONTAINS A BREAKING CHANGE — READ BEFORE UPGRADING
  
  **Released as a minor deliberately, by the package owner, because the framework
  had no external adopters at the time.** Semver would normally make this a major.
  If you are on `^2.0.0` you will receive it automatically, so upgrade with this
  note in hand rather than on autopilot.
  
  **`queuePlugin({ connection })` no longer exists.** The BullMQ driver has moved
  out of this package into `@basaltkit/queue-bullmq`, leaving the core a pure
  driver contract with no knowledge of any backend.
  
  ### What was removed
  
  | Removed | Replacement |
  | --- | --- |
  | `queuePlugin({ connection })` | `bullmqQueuePlugin({ connection })` from `@basaltkit/queue-bullmq` |
  | `queuePlugin({ onError, onJobFailed })` | the same keys on `bullmqQueuePlugin` |
  | `@basaltkit/queue/bullmq` subpath | `@basaltkit/queue-bullmq` |
  | `BullmqDriverOptions` type export | re-exported from `@basaltkit/queue-bullmq` |
  | `MissingQueueDriverPackageError` | gone — you now import the package you use, so there is no optional peer left to be missing |
  
  ### Migration
  
  ```bash
  pnpm add @basaltkit/queue-bullmq
  ```
  
  ```diff
  -import { queuePlugin } from '@basaltkit/queue'
  +import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'
  
  -queuePlugin({ connection: process.env.REDIS_URL, jobs, workers })
  +bullmqQueuePlugin({ connection: process.env.REDIS_URL!, jobs, workers })
  ```
  
  Nothing else changes: `defineJob`, `dispatch`, workers, context propagation,
  `QUEUE` and `QueueManager` are all untouched. If you were already passing an
  explicit `driver`, or using the sync driver, **you are unaffected**.
  
  ### Why
  
  2.0.0 made `bullmq` an optional peer, which stopped forcing the install — but
  the core still carried the driver's source, a lazy-load cache, a subpath export
  and a missing-package error, all of it complexity that existed only to work
  around the structure. Extraction deletes all of it.
  
  It also removes a DX asymmetry that predated the fix: BullMQ got
  `connection: url` while RabbitMQ, SQS and Kafka wrote `driver: new X()`. Now
  each backend ships an equivalent one-line plugin, and `queuePlugin` is what they
  all wrap.
  
  ### Also in this release
  
  - `RetentionOption` is now exported. Every driver package needs it to map the
    neutral retention onto its backend's vocabulary, making it part of the
    contract rather than an internal detail.
  - `queuePlugin`'s `register` is synchronous again (the lazy driver import that
    made it async is gone).
  - With no `driver`, the production warning now names the backend plugins.

## 2.0.0

### Major Changes

- ffd3565: **BREAKING — `bullmq` is now an optional peer dependency, not a dependency.**
  
  **Remedy (one line):** if your app passes `queuePlugin({ connection })` or uses
  `BullmqQueueDriver`, run `pnpm add bullmq` (`^6.2.1`). Nothing else changes.
  Apps on RabbitMQ/SQS/Kafka or the sync driver need no action — and stop
  installing BullMQ (plus its ioredis transitive weight) altogether.
  
  **What was wrong.** `@basaltkit/queue` is the *driver-agnostic* core, yet it
  declared `bullmq` in `dependencies` and its barrel statically re-exported
  `drivers/bullmq.js`, which imports `bullmq` at module scope. Every consumer
  therefore installed **and loaded** BullMQ, whichever backend they actually ran
  on. This was historical, not intentional: BullMQ predates the
  `@basaltkit/queue-rabbitmq` / `-sqs` / `-kafka` satellites — which all correctly
  declare their client as a peer — and nobody realigned it when they arrived.
  
  **What changed.**
  
  - `bullmq` moved to `peerDependencies` with
    `peerDependenciesMeta: { bullmq: { optional: true } }`.
  - The barrel no longer pulls the driver. `queuePlugin({ connection })` resolves
    `drivers/bullmq.js` with a cached `await import()` during the plugin's
    `register` phase (which `BasaltApp.boot()` already awaits — the lifecycle
    contract is unchanged). Registration still opens no connection: the driver is
    constructed, and Redis first touched, when `QUEUE` is resolved, exactly as
    before.
  - `BullmqQueueDriver` now has its **own entry point**, matching the one-import-
    path-per-backend shape of the driver packages:
  
    ```diff
    - import { queuePlugin, BullmqQueueDriver } from '@basaltkit/queue'
    + import { queuePlugin } from '@basaltkit/queue'
    + import { BullmqQueueDriver } from '@basaltkit/queue/bullmq'
    ```
  
    The `BullmqDriverOptions` **type** is still exported from `@basaltkit/queue`
    (types are erased at build, so they cost a consumer nothing).
  - Selecting BullMQ without the peer installed now throws
    `MissingQueueDriverPackageError` (`QUEUE_MISSING_DRIVER_PACKAGE`) at boot,
    naming the fix and the alternatives, with the original resolution failure kept
    as `.cause` — instead of a bare `ERR_MODULE_NOT_FOUND` from inside the driver.
  
  **Guarded against regression** by two new tests in this package:
  `tests/lazy-bullmq.test.ts` (a `bullmq` mock factory that must not be evaluated
  when the barrel is imported or the sync path boots) and
  `tests/driver-boundary.test.ts` — a repo-wide structural rule, modeled on the
  existing adapter- and SaaS-boundary tests, that no package may force a concrete
  backend client onto its consumers, nor reach one through its main entry's static
  import graph.

## 1.5.0

### Minor Changes

- 8d25857: Add `list()` — the supported way to inspect **which** jobs are on a queue.
  
  `QueueDriver` gains an optional `list(queue, { states?, limit? })`, alongside the
  existing optional `stats()` / `retryFailed()`, and `QueueManager.list()` mirrors
  them: `undefined` when the driver can't do it, so callers get an honest
  "unsupported" instead of a guess. Implemented by the **BullMQ** driver (Redis
  keeps jobs, so reading is non-destructive).
  
  Results are driver-neutral `JobSummary` objects — `{ id, name, state,
  attemptsMade, timestamp, payload, context?, failedReason? }` — never the
  backend's own job type, and with `payload` already unwrapped from the
  `{ payload, context }` dispatch envelope. Defaults: states
  `['completed', 'failed', 'waiting', 'active']` (a healthy queue has
  `waiting`/`active` empty, so defaulting to only those would report "no jobs" on a
  queue that is working) and `limit` 20 in total, newest first, capped at 1000.
  
  New CLI command `basalt queue:jobs --queue --states --limit [--payload]`,
  alongside `queue:stats` / `queue:retry`. **Payloads are hidden unless `--payload`
  is passed** — a job payload can carry personal data.
  
  Also exported for custom drivers: `JobState`, `JobSummary`, `JobEnvelope`,
  `ListJobsOptions`, `readJobEnvelope`, `DEFAULT_LIST_STATES`,
  `DEFAULT_LIST_LIMIT`, `MAX_LIST_LIMIT`. No breaking change: `list` is optional
  and existing drivers keep working unchanged.

## 1.4.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1
  - @basaltkit/events@1.1.1

## 1.4.0

### Minor Changes

- 59cf29c: `queuePlugin` accepts `onError` and `onJobFailed` and forwards them to the BullMQ driver it builds from `connection`.
  
  The crash-safety and failure-visibility hooks added in 1.3.0 lived only on `BullmqDriverOptions`, and `queuePlugin({ connection })` constructed the driver with the connection **and nothing else** — `QueuePluginOptions` did not even accept the callbacks. On the documented shorthand path the work was therefore unreachable: the only way to route a Redis outage or a permanently-failed job to your logger was to hand-build the driver and pass it as `driver`.
  
  Both callbacks are now plugin options:
  
  ```ts
  queuePlugin({
    connection: process.env.REDIS_URL!,
    jobs,
    workers,
    onError: (error, { queue, source }) => log.error({ queue, source, error }, 'queue infra error'),
    onJobFailed: ({ queue, job, jobId, error }) => alertDeadJob(queue, job, jobId, error),
  })
  ```
  
  They are forwarded only to the driver built from `connection`, and are ignored when you supply your own `driver` — that driver owns its callbacks. Defaults are unchanged (a contextual `console.error`), so nothing behaves differently unless you pass a callback.

## 1.3.1

### Patch Changes

- cc4786e: **Sync (inline) driver: bounded memory and a loud production fallback (Q-6).** The driver's `executed[]` history grew unboundedly — a long-running process on the no-Redis default leaked memory forever; it is now capped at the most recent 1000 entries. And because the sync driver is the silent default when `connection` is unset, a production deploy that forgot `REDIS_URL` inverted queue semantics without a trace (at-most-once, handler errors rejecting `dispatch()` inside the request). `queuePlugin` now logs a boot warning when the sync driver is selected implicitly with `NODE_ENV=production`; pass `driver: new SyncQueueDriver()` to opt in deliberately. The inline/at-most-once/error-propagation semantics themselves are unchanged and now documented.
- Updated dependencies [cc4786e]
  - @basaltkit/events@1.1.0

## 1.3.0

### Minor Changes

- 1050b3d: Queue workers no longer crash on infra errors, and permanent job failures are observable.
  
  BullMQ's `Worker`/`Queue` and amqplib's connection/channel are EventEmitters; an emitted `'error'` with no listener is fatal in Node (uncaught → process crash), and without a `'failed'` listener a job exhausting its retries vanished silently. The BullMQ driver now attaches `error` + `failed` listeners (new `onError` / `onJobFailed` options), and the RabbitMQ driver attaches `error` listeners to the connection and channel (new `onError` option). All default to `console.error` with full context — observable, never fatal, never silent — matching realtime's `onBridgeError` pattern. (Rabbit's separate ack-before-confirm job-loss window remains tracked as Q-7.)

## 1.2.0

### Minor Changes

- 0e82c96: Add the `queue:work`, `queue:stats` and `queue:retry` CLI commands.

  `queuePlugin` now registers three commands into the CLI command bucket:

  - **`queue:work --queue --concurrency`** — run a worker until interrupted.
  - **`queue:stats --queue`** — job counts (waiting/active/completed/failed/delayed).
  - **`queue:retry --queue --limit`** — re-enqueue failed jobs.

  Backed by an optional driver introspection surface (`QueueDriver.stats` / `retryFailed`, exposed via `QueueManager.stats()` / `retryFailed()`), implemented for the BullMQ driver. The inline sync driver keeps no job state, so `stats`/`retry` report the operation as unsupported instead of guessing.

## 1.1.0

### Minor Changes

- **Configurable Redis retention for finished jobs.** The BullMQ driver kept the last 1000 completed jobs and **all** failed jobs (`removeOnFail: false`) forever — the failed set could grow unbounded. You can now set `removeOnComplete`/`removeOnFail` on `queuePlugin` (global default) or per job via `defineJob` — `true` (remove on finish), a count, or `{ age: "14d", count: 500 }`. The previous defaults are preserved when unset (completed keep 1000, failed keep all). The sync driver ignores it.

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
- @basaltkit/events@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/events@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/events@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/events@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/events@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/events@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/events@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/events@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/events@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/events@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/events@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/events@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/events@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/events@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/events@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/events@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/events@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/events@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/events@0.7.0

## 0.6.0

### Minor Changes

- f155979: Add driver capability checks so unsupported job options fail loudly instead of being silently dropped.

  Backends differ — a driver may not honor delayed delivery, priority, retries, or retry backoff (Kafka has no message priority, a naive RabbitMQ setup has no delayed jobs, the sync driver runs inline). A driver now declares a `capabilities` object (`{ delayed, priority, retries, backoff }`), and the `QueueManager` checks each dispatch's options against it.

  - New `DriverCapabilities` type; `QueueDriver` gains optional `name` and `capabilities`. `BullmqQueueDriver` declares full support; `SyncQueueDriver` declares `{ delayed: false, priority: false, retries: true, backoff: false }`.
  - `queuePlugin({ onUnsupported })` / `new QueueManager(driver, { onUnsupported })` chooses the reaction: `'warn'` (default — logs once per job+feature, then proceeds), `'throw'` (raise `UnsupportedJobOptionError`, recommended in production), or `'ignore'` (legacy silent behavior).
  - Back-compatible: a driver that omits `capabilities` is assumed fully capable, so existing custom drivers are unaffected. This is the seam a future `@basaltkit/queue-rabbitmq` / `@basaltkit/queue-kafka` driver plugs into.

### Patch Changes

- f2e8298: `queuePlugin({ jobs })` now accepts typed jobs without a cast. The option was typed `JobDefinition<never>[]`, so a job carrying payload data (`defineJob<{ ... }>`) forced a `as JobDefinition<never>` cast; it is now `JobDefinition<unknown>[]`, which accepts both typed and untyped jobs.
  - @basaltkit/core@0.6.0
  - @basaltkit/events@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1
- @basaltkit/events@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/events@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0
- @basaltkit/events@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0
  - @basaltkit/events@0.3.0

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
  - @basaltkit/events@0.1.0
