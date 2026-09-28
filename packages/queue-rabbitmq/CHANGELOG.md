# @basaltkit/queue-rabbitmq

## 1.4.0

### Minor Changes

- e53db52: Queue hardening from the framework audit (FA-062, FA-063, FA-064, FA-066).
  
  **`@basaltkit/queue` (major)**
  
  - **The worker restores a validated, minimal context (FA-062).** It used to spread the envelope's `context` into the ALS, so anyone able to write to the broker could inject any field (`user`, `tenant`, …). The context is now rebuilt from an allowlist: `requestId`/`correlationId`/`traceId` (dropped if malformed), `tenant: { id }` + `tenantId` (the id must pass the tenancy grammar; the two must agree) and `userId`. A malformed `tenant`/`tenantId`/`userId` rejects the job with `JobContextError` — it is never run with the field dropped, which would widen it to the central scope.
  - **Jobs now carry an actor.** `userId` is also restored as `user: { id }`, so `@basaltkit/audit` records the dispatcher as `actorId` and `gate.actor()` re-reads that user's roles in the job's tenant (roles never come from the message). Previously jobs had no `user`, so audit entries written from a job had no actor and permission checks in a job always saw a guest.
  - **Optional signed envelopes.** New `signingKey` option (plugin and `QueueManager`; ≥ 32 bytes; an array rotates — the first signs, every key verifies). Each envelope carries an HMAC-SHA256 over the job name, payload and context, and the worker rejects unsigned or altered jobs with `JobSignatureError`. Without a key the broker is trusted, as before — now documented as the trust boundary.
  - **Job names are unique per manager (FA-063).** Registering a *different* definition under a taken name — including a second `queuedOn` listener on the same event — now throws `DuplicateJobError` instead of silently replacing the first handler. Registering the same definition twice stays a no-op. `queuedOn` gains a `name` option for multiple queued listeners on one event.
  - **`attempts` bounds (FA-066).** `defineJob` throws on an `attempts` that is not a positive integer (the sync driver used to skip the handler and reject with `undefined` on `0`); the sync driver caps inline retries at the new `MAX_JOB_ATTEMPTS` (50).
  - **`queue:retry` / `queue:jobs --limit` must be a positive integer (FA-066).** `--limit 0` used to reach BullMQ as `getFailed(0, -1)` — "to the end" — and re-enqueue every failed job.
  - New exports: `DuplicateJobError`, `JobSignatureError`, `JobContextError`, `MAX_JOB_ATTEMPTS`, `MIN_SIGNING_KEY_BYTES`, `isDefaultTenantId`, `QueueSigningKey`, `QUEUE_PLUGIN_OPTION_KEYS`, `splitQueuePluginOptions`; `JobEnvelope` gains an optional `sig`; new plugin/manager option `validateTenantId`.
  
  Migration:
  
  1. Duplicate job names: rename one of the two jobs; for two `queuedOn` listeners on one event, give the second `{ name: '<event>:<purpose>' }`.
  2. `attempts: 0` (or negative/fractional): use `1` or more.
  3. Custom tenant-id grammar in `tenancyPlugin({ validateTenantId })`: pass the same function to the queue plugin, or jobs carrying such tenants are rejected with `JobContextError`.
  4. Permission checks inside jobs now see the dispatching user (with their current roles in the job's tenant) instead of no user. If a job relied on running as a guest, dispatch it without the user: `runWithContext({ ...tryCtx(), user: undefined, userId: undefined }, () => job.dispatch(payload))`.
  5. Adopting `signingKey`: deploy it to producers and workers together and drain queued unsigned jobs first — a worker with a key rejects them.
  
  **`@basaltkit/queue-bullmq` (minor)**
  
  - `onJobFailed` now fires once per job, on the final failure (or an `UnrecoverableError`). BullMQ emits `'failed'` after every attempt, so it used to fire for attempts that were about to be retried (FA-064).
  - `retryFailed` with a non-positive or non-numeric `limit` retries nothing (it used to retry every failed job).
  - Percent-encoded credentials in a `redis://` URL are decoded before they reach ioredis (FA-066).
  - `bullmqQueuePlugin` forwards the new core options (`signingKey`, `validateTenantId`) via `splitQueuePluginOptions`.
  
  **`@basaltkit/queue-rabbitmq` (minor)**
  
  - A negative `x-basalt-attempt` header no longer buys unlimited retries: the attempt is clamped to `1..50`; a negative backoff header no longer becomes a negative `expiration` that closes the channel (FA-064).
  - Channel/connection loss is recovered: the dead channel is dropped, the next `add()` reopens one, and workers are re-subscribed with exponential backoff (new option `reconnectDelayMs`, default 1000 ms, capped at 30 s). A failed connect is no longer cached forever. `AmqpChannel.on`/`AmqpConnection.on` now also accept `'close'`.
  - Plugin forwards `signingKey`/`validateTenantId`.
  
  **`@basaltkit/queue-sqs` (minor)**
  
  - A failed delete after a **successful** job no longer counts as a job failure (it used to re-send a retry copy of completed work); it is reported via `onError` with `stage: 'delete'`. A failed retry/dead-letter re-send is reported with `stage: 'reroute'` and keeps the original for redelivery. Neither ends the poller any more, and a poller failing before its loop is reported instead of becoming an unhandled rejection. `onError`'s info gains an optional `stage` (FA-064).
  - A negative `x-basalt-attempt` attribute is clamped to `1..50`; a negative backoff counts as none.
  - Plugin forwards `signingKey`/`validateTenantId`.
  
  **`@basaltkit/queue-kafka` (patch)**
  
  - A negative (or garbage) `x-basalt-attempt` header is clamped to `1..50` instead of buying unlimited retries (FA-064). Plugin forwards `signingKey`/`validateTenantId`.

### Patch Changes

- Updated dependencies [e54b7b1]
- Updated dependencies [e53db52]
  - @basaltkit/queue@3.0.0

## 1.3.0

### Minor Changes

- 4586ff4: **New: `rabbitmqQueuePlugin`** — the one-line way to register this backend,
  matching `bullmqQueuePlugin` and the other satellites so no backend is
  privileged in the core's API.
  
  ```diff
  -import { queuePlugin } from '@basaltkit/queue'
  -import { RabbitmqQueueDriver } from '@basaltkit/queue-rabbitmq'
  +import { rabbitmqQueuePlugin } from '@basaltkit/queue-rabbitmq'
  
  -queuePlugin({ driver: new RabbitmqQueueDriver({ url: process.env.AMQP_URL! }), jobs, workers })
  +rabbitmqQueuePlugin({ url: process.env.AMQP_URL!, jobs, workers })
  ```
  
  It accepts every `queuePlugin` option (`jobs`, `workers`, `onUnsupported`,
  `removeOnComplete`, `removeOnFail`) alongside this driver's own options, and
  splits them by the *core's* keys — so a driver option added later flows through
  untouched.
  
  Purely additive: `RabbitmqQueueDriver` is still exported and
  `queuePlugin({ driver })` still works.

### Patch Changes

- Updated dependencies [4586ff4]
  - @basaltkit/queue@2.1.0

## 1.2.3

### Patch Changes

- Updated dependencies [ffd3565]
  - @basaltkit/queue@2.0.0

## 1.2.2

### Patch Changes

- 8d25857: Document why these drivers deliberately omit the queue's new optional `list()`
  capability (so `basalt queue:jobs` reports it as unsupported rather than faking
  it): AMQP has no non-destructive read (`basic.get`/consume hide the message from
  real workers and mark it redelivered); SQS's `ReceiveMessage` starts the
  visibility timeout and bumps `ApproximateReceiveCount`, so peeking could redrive
  jobs into the DLQ; and Kafka, while non-destructive to read, is a log with no
  per-message state, so any job states would be invented. Looking at a queue must
  never change it. The CLI README now lists `queue:jobs` among the plugin-registered
  commands.
- Updated dependencies [8d25857]
  - @basaltkit/queue@1.5.0

## 1.2.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/queue@1.4.1

## 1.2.0

### Minor Changes

- cc4786e: **Reliability (Q-7): publisher confirms before ack, graceful shutdown drain, and visible worker-boot failures.**
  
  **What was exposed.** On handler failure the driver re-published the job to the retry/dead-letter queue on a plain channel and immediately `ack`ed the original — if that unconfirmed publish was lost (broker fault, closed channel), the ack had already destroyed the only durable copy: silent job loss. `close()` tore the channel down under in-flight handlers, whose acks then threw into the consume callback as fatal unhandled rejections; and `startWorker`'s fire-and-forget connect meant a broker-unreachable boot left the app "healthy" with zero workers.
  
  **What changed.** The driver now prefers a publisher-confirm channel (`createConfirmChannel`, with fallback for connections that lack it) and awaits `waitForConfirms` after every publish — in `add()` before reporting the job dispatched, and in the failure path BEFORE acking, so the broker owns the re-routed copy first; if the confirm fails, nothing is acked and the broker redelivers (at-least-once, never silent loss). `close()` drains in-flight handlers with a deadline (new `drainTimeoutMs` option, default 10 s); messages arriving mid-shutdown are left unacked for redelivery. Worker-boot and ack/publish faults surface through `onError` instead of crashing. `AmqpChannel`/`AmqpConnection` gain optional `waitForConfirms`/`createConfirmChannel` members (additive; existing fakes keep working).

### Patch Changes

- Updated dependencies [cc4786e]
  - @basaltkit/queue@1.3.1

## 1.1.0

### Minor Changes

- 1050b3d: Queue workers no longer crash on infra errors, and permanent job failures are observable.
  
  BullMQ's `Worker`/`Queue` and amqplib's connection/channel are EventEmitters; an emitted `'error'` with no listener is fatal in Node (uncaught → process crash), and without a `'failed'` listener a job exhausting its retries vanished silently. The BullMQ driver now attaches `error` + `failed` listeners (new `onError` / `onJobFailed` options), and the RabbitMQ driver attaches `error` listeners to the connection and channel (new `onError` option). All default to `console.error` with full context — observable, never fatal, never silent — matching realtime's `onBridgeError` pattern. (Rabbit's separate ack-before-confirm job-loss window remains tracked as Q-7.)

### Patch Changes

- Updated dependencies [1050b3d]
  - @basaltkit/queue@1.3.0

## 1.0.1

### Patch Changes

- Security (defense-in-depth): clamp the max-retry count and the exponential-backoff exponent read from an (untrusted) message to hard ceilings (50 attempts; backoff ≤ 24h), so a crafted `x-basalt-attempts`/backoff header can't drive a retry-amplification loop or an absurd/`Infinity` message TTL. Requires broker write access to exploit.

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

- @basaltkit/queue@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/queue@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/queue@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/queue@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/queue@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/queue@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/queue@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/queue@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/queue@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/queue@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/queue@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/queue@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/queue@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/queue@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/queue@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/queue@0.9.0

## 0.8.1

### Patch Changes

- 8ef02f4: Add package READMEs. The three queue-driver packages were published without a README (npm showed "This package does not have a README"). Each now documents installation (including the peer dependency), a quick start, how the backend maps retries/backoff/delay and dead-lettering, its honest capability profile, and an options reference.
  - @basaltkit/queue@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/queue@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/queue@0.7.0

## 0.6.0

### Minor Changes

- f2e8298: New package: `@basaltkit/queue-rabbitmq` — a RabbitMQ driver for `@basaltkit/queue`.

  `RabbitmqQueueDriver` implements the `QueueDriver` seam over AMQP (amqplib, an optional peer dependency): jobs publish to durable queues, retries and backoff use a per-queue delay queue (`<queue>.delay`) that dead-letters back via message TTL, exhausted jobs land in `<queue>.dead`, and priority uses `x-max-priority`. It declares full `capabilities` (`delayed`, `priority`, `retries`, `backoff`). The connector is injectable, so the retry/backoff/DLQ logic is unit-tested without a broker.

  ```ts
  import { RabbitmqQueueDriver } from "@basaltkit/queue-rabbitmq";
  queuePlugin({
    driver: new RabbitmqQueueDriver({ url: env.AMQP_URL }),
    jobs,
    workers,
  });
  ```

### Patch Changes

- Updated dependencies [f155979]
- Updated dependencies [f2e8298]
  - @basaltkit/queue@0.6.0
