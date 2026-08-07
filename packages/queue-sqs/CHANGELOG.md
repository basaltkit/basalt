# @machize/queue-sqs

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

### Minor Changes

- d3e92ac: New package: `@machize/queue-sqs` — an Amazon SQS driver for `@machize/queue`.

  `SqsQueueDriver` sends jobs to SQS and long-polls them back (AWS SDK v3, an optional peer dependency). Its `capabilities` are honest about SQS's shape: `delayed: true` (native per-message delay, capped at 15 minutes — an over-limit delay throws `SqsDelayTooLongError`) but `priority: false` (SQS has no priority, so a priority dispatch is caught by the queue's `onUnsupported` policy). Retries and backoff are handled at the app level for parity with the other drivers: a failed job is re-sent with an incremented attempt and a `DelaySeconds` backoff (clamped to 15 min), and an exhausted job goes to the dead-letter queue (`<queue><deadSuffix>`). Provide a `queueUrl` resolver mapping queue names — including the DLQ — to their SQS URLs; the SQS API is injectable, so the retry/DLQ logic is unit-tested without AWS.

  ```ts
  import { SqsQueueDriver } from "@machize/queue-sqs";
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

- @machize/queue@0.8.0
