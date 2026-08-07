---
'@machize/queue-sqs': minor
---

New package: `@machize/queue-sqs` — an Amazon SQS driver for `@machize/queue`.

`SqsQueueDriver` sends jobs to SQS and long-polls them back (AWS SDK v3, an optional peer dependency). Its `capabilities` are honest about SQS's shape: `delayed: true` (native per-message delay, capped at 15 minutes — an over-limit delay throws `SqsDelayTooLongError`) but `priority: false` (SQS has no priority, so a priority dispatch is caught by the queue's `onUnsupported` policy). Retries and backoff are handled at the app level for parity with the other drivers: a failed job is re-sent with an incremented attempt and a `DelaySeconds` backoff (clamped to 15 min), and an exhausted job goes to the dead-letter queue (`<queue><deadSuffix>`). Provide a `queueUrl` resolver mapping queue names — including the DLQ — to their SQS URLs; the SQS API is injectable, so the retry/DLQ logic is unit-tested without AWS.

```ts
import { SqsQueueDriver } from '@machize/queue-sqs'
queuePlugin({
  driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => QUEUE_URLS[q] }),
  jobs,
  workers,
})
```
