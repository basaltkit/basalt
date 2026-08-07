# @machize/queue-kafka

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
