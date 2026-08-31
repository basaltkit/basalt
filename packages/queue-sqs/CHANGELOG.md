# @basaltkit/queue-sqs

## 1.2.0

### Minor Changes

- 4586ff4: **New: `sqsQueuePlugin`** — the one-line way to register this backend,
  matching `bullmqQueuePlugin` and the other satellites so no backend is
  privileged in the core's API.
  
  ```diff
  -import { queuePlugin } from '@basaltkit/queue'
  -import { SqsQueueDriver } from '@basaltkit/queue-sqs'
  +import { sqsQueuePlugin } from '@basaltkit/queue-sqs'
  
  -queuePlugin({ driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => URLS[q]! }), jobs, workers })
  +sqsQueuePlugin({ region: 'eu-west-1', queueUrl: (q) => URLS[q]!, jobs, workers })
  ```
  
  It accepts every `queuePlugin` option (`jobs`, `workers`, `onUnsupported`,
  `removeOnComplete`, `removeOnFail`) alongside this driver's own options, and
  splits them by the *core's* keys — so a driver option added later flows through
  untouched.
  
  Purely additive: `SqsQueueDriver` is still exported and
  `queuePlugin({ driver })` still works.

### Patch Changes

- Updated dependencies [4586ff4]
  - @basaltkit/queue@2.1.0

## 1.1.3

### Patch Changes

- Updated dependencies [ffd3565]
  - @basaltkit/queue@2.0.0

## 1.1.2

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

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/queue@1.4.1

## 1.1.0

### Minor Changes

- cc4786e: **Receive errors are visible and paced (Q-8 pin).** A failing `ReceiveMessage` (bad credentials, deleted queue, network fault) was swallowed and retried immediately — a silent, CPU-burning hot spin with zero log output. The poller now reports each failure through the new `onError` option (default: `console.error` with the queue name) and pauses `errorPauseMs` (default 1 s) before retrying.

### Patch Changes

- Updated dependencies [cc4786e]
  - @basaltkit/queue@1.3.1

## 1.0.1

### Patch Changes

- Security (defense-in-depth): clamp the max-retry count read from an (untrusted) message to a hard ceiling (50), so a crafted `x-basalt-attempts` header can't drive a retry-amplification loop. Requires broker write access to exploit.

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

### Minor Changes

- d3e92ac: New package: `@basaltkit/queue-sqs` — an Amazon SQS driver for `@basaltkit/queue`.

  `SqsQueueDriver` sends jobs to SQS and long-polls them back (AWS SDK v3, an optional peer dependency). Its `capabilities` are honest about SQS's shape: `delayed: true` (native per-message delay, capped at 15 minutes — an over-limit delay throws `SqsDelayTooLongError`) but `priority: false` (SQS has no priority, so a priority dispatch is caught by the queue's `onUnsupported` policy). Retries and backoff are handled at the app level for parity with the other drivers: a failed job is re-sent with an incremented attempt and a `DelaySeconds` backoff (clamped to 15 min), and an exhausted job goes to the dead-letter queue (`<queue><deadSuffix>`). Provide a `queueUrl` resolver mapping queue names — including the DLQ — to their SQS URLs; the SQS API is injectable, so the retry/DLQ logic is unit-tested without AWS.

  ```ts
  import { SqsQueueDriver } from "@basaltkit/queue-sqs";
  queuePlugin({
    driver: new SqsQueueDriver({
      region: "eu-west-1",
      queueUrl: (q) => QUEUE_URLS[q],
    }),
    jobs,
    workers,
  });
  ```

### Patch Changes

- @basaltkit/queue@0.8.0
