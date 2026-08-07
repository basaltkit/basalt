# @machize/queue-rabbitmq

## 0.6.0

### Minor Changes

- f2e8298: New package: `@machize/queue-rabbitmq` — a RabbitMQ driver for `@machize/queue`.

  `RabbitmqQueueDriver` implements the `QueueDriver` seam over AMQP (amqplib, an optional peer dependency): jobs publish to durable queues, retries and backoff use a per-queue delay queue (`<queue>.delay`) that dead-letters back via message TTL, exhausted jobs land in `<queue>.dead`, and priority uses `x-max-priority`. It declares full `capabilities` (`delayed`, `priority`, `retries`, `backoff`). The connector is injectable, so the retry/backoff/DLQ logic is unit-tested without a broker.

  ```ts
  import { RabbitmqQueueDriver } from "@machize/queue-rabbitmq";
  queuePlugin({
    driver: new RabbitmqQueueDriver({ url: env.AMQP_URL }),
    jobs,
    workers,
  });
  ```

### Patch Changes

- Updated dependencies [f155979]
- Updated dependencies [f2e8298]
  - @machize/queue@0.6.0
