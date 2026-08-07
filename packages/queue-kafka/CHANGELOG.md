# @machize/queue-kafka

## 0.10.0

### Patch Changes

- @machize/queue@0.10.0

## 0.9.0

### Patch Changes

- @machize/queue@0.9.0

## 0.8.1

### Patch Changes

- 8ef02f4: Add package READMEs. The three queue-driver packages were published without a README (npm showed "This package does not have a README"). Each now documents installation (including the peer dependency), a quick start, how the backend maps retries/backoff/delay and dead-lettering, its honest capability profile, and an options reference.
  - @machize/queue@0.8.1

## 0.8.0

### Patch Changes

- @machize/queue@0.8.0

## 0.7.0

### Minor Changes

- 9505499: New package: `@machize/queue-kafka` — a Kafka driver for `@machize/queue`.

  `KafkaQueueDriver` produces jobs to a topic and consumes them with a consumer group (kafkajs, an optional peer dependency). It is deliberately honest about what Kafka can't do: `capabilities` declares `delayed: false` and `priority: false` (Kafka has neither), so the queue's `onUnsupported` policy catches those at dispatch instead of silently dropping them. Retries use a retry topic (`<topic>.retry`) the worker also consumes, with exhausted jobs sent to `<topic>.dead`; there is no backoff delay, so `backoff` is `false` too. Worker concurrency maps to `partitionsConsumedConcurrently`. The client is injectable, so the retry/DLQ logic is unit-tested without a broker.

  ```ts
  import { KafkaQueueDriver } from "@machize/queue-kafka";
  queuePlugin({
    driver: new KafkaQueueDriver({ brokers: ["localhost:9092"] }),
    jobs,
    workers,
  });
  ```

### Patch Changes

- @machize/queue@0.7.0
