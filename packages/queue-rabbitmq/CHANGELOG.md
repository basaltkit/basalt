# @machize/queue-rabbitmq

## 0.18.0

### Patch Changes

- @machize/queue@0.18.0

## 0.17.0

### Patch Changes

- @machize/queue@0.17.0

## 0.16.0

### Patch Changes

- @machize/queue@0.16.0

## 0.15.0

### Patch Changes

- @machize/queue@0.15.0

## 0.14.0

### Patch Changes

- @machize/queue@0.14.0

## 0.13.0

### Patch Changes

- @machize/queue@0.13.0

## 0.12.0

### Patch Changes

- @machize/queue@0.12.0

## 0.11.0

### Patch Changes

- @machize/queue@0.11.0

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

### Patch Changes

- @machize/queue@0.7.0

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
