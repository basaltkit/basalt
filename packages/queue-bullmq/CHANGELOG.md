# @basaltkit/queue-bullmq

## 1.1.0

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

## 1.0.0

### Major Changes

- 4586ff4: **New package: the BullMQ/Redis driver and plugin for `@basaltkit/queue`**,
  extracted from the core so that no backend is privileged in the core's API.
  
  ```bash
  pnpm add @basaltkit/queue @basaltkit/queue-bullmq bullmq
  ```
  
  ```ts
  import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'
  
  bullmqQueuePlugin({
    connection: process.env.REDIS_URL!,
    jobs: [SendWelcome],
    workers: [{ queue: 'welcome', concurrency: 5 }],
  })
  ```
  
  Exports `bullmqQueuePlugin`, `BullmqQueueDriver` and `BullmqDriverOptions`. The
  plugin accepts every `queuePlugin` option (`jobs`, `workers`, `onUnsupported`,
  `removeOnComplete`, `removeOnFail`) alongside the driver's own `connection`,
  `onError` and `onJobFailed`.
  
  The driver code is unchanged from `@basaltkit/queue@2.0.0` — this is a move, not
  a rewrite, and its tests moved with it. `bullmq` is a **required** peer
  dependency here, which is what licenses this package (unlike the core) to import
  it statically.
  
  Coming from `queuePlugin({ connection })`? See the `@basaltkit/queue` entry in
  this release for the migration.

### Patch Changes

- Updated dependencies [4586ff4]
  - @basaltkit/queue@2.1.0
