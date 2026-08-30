# @basaltkit/queue-rabbitmq

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
