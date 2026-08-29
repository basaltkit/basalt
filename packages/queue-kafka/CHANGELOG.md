# @basaltkit/queue-kafka

## 1.1.0

### Minor Changes

- a76d591: **Infrastructure faults are now observable (`onError`) instead of process-fatal or silent — the same pattern as the rabbitmq/sqs drivers.**
  
  - `startWorker` was a floating `void (async …)()`: a broker connect/subscribe/run failure at boot became an **unhandled rejection** (process-fatal by Node's default) — or, caught by nothing, an app that reports healthy with **zero workers**. It now surfaces through the new `onError` option (`(error, { source: 'consumer' | 'producer', queue })`, default: contextual `console.error`).
  - A failed retry/dead-letter **re-publish** inside the consume callback used to throw raw into the consumer. It now reports through `onError` and then rethrows deliberately, so the offset is **not** committed and Kafka redelivers the message — a producer outage can no longer silently lose a failing job (the Kafka equivalent of rabbitmq's keep-unacked).

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

### Patch Changes

- @basaltkit/queue@0.8.0

## 0.7.0

### Minor Changes

- 9505499: New package: `@basaltkit/queue-kafka` — a Kafka driver for `@basaltkit/queue`.

  `KafkaQueueDriver` produces jobs to a topic and consumes them with a consumer group (kafkajs, an optional peer dependency). It is deliberately honest about what Kafka can't do: `capabilities` declares `delayed: false` and `priority: false` (Kafka has neither), so the queue's `onUnsupported` policy catches those at dispatch instead of silently dropping them. Retries use a retry topic (`<topic>.retry`) the worker also consumes, with exhausted jobs sent to `<topic>.dead`; there is no backoff delay, so `backoff` is `false` too. Worker concurrency maps to `partitionsConsumedConcurrently`. The client is injectable, so the retry/DLQ logic is unit-tested without a broker.

  ```ts
  import { KafkaQueueDriver } from "@basaltkit/queue-kafka";
  queuePlugin({
    driver: new KafkaQueueDriver({ brokers: ["localhost:9092"] }),
    jobs,
    workers,
  });
  ```

### Patch Changes

- @basaltkit/queue@0.7.0
