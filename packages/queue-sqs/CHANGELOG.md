# @basaltkit/queue-sqs

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
