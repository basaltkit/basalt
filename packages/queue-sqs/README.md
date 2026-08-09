# @basaltkit/queue-sqs

**Amazon SQS** driver for [`@basaltkit/queue`](https://www.npmjs.com/package/@basaltkit/queue): runs your jobs on AWS-managed SQS queues, without changing your job code. You need this package when you run on AWS and want a serverless queue, with no Redis or broker to maintain.

## What this module solves

`@basaltkit/queue` defines **jobs** abstractly and chooses the backend via a *driver*. This package provides a driver that talks to **SQS**: jobs are sent to an SQS queue and received via *long-polling*.

`defineJob`, `dispatch`, the workers, and context propagation all stay the same — you only swap the driver.

## Installation

```bash
pnpm add @basaltkit/queue-sqs @aws-sdk/client-sqs
```

`@aws-sdk/client-sqs` (AWS SDK v3) is a **peer dependency**. Credentials are resolved through the standard AWS chain (environment variables, profile, IAM role…).

## Get started in 5 minutes

SQS identifies queues by **URL**, so you pass a `queueUrl` resolver that maps a queue name (and its dead-letter queue) to the SQS URL:

```ts
import { createApp } from '@basaltkit/core'
import { queuePlugin, defineJob } from '@basaltkit/queue'
import { SqsQueueDriver } from '@basaltkit/queue-sqs'

const QUEUE_URLS: Record<string, string> = {
  emails: 'https://sqs.eu-west-1.amazonaws.com/123456789012/emails',
  'emails-dead': 'https://sqs.eu-west-1.amazonaws.com/123456789012/emails-dead',
}

const SendWelcome = defineJob<{ email: string }>({
  name: 'send-welcome',
  queue: 'emails',
  attempts: 3,
  backoff: { type: 'exponential', delay: '30s' },
  async handle({ email }) {
    // ... send it
  },
})

const app = await createApp({
  plugins: [
    queuePlugin({
      driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => QUEUE_URLS[q]! }),
      jobs: [SendWelcome],
      workers: [{ queue: 'emails', concurrency: 5 }],
    }),
  ],
}).boot()

await SendWelcome.dispatch({ email: 'ada@acme.test' }, { delay: '2m' })
```

## Capabilities — SQS profile

| Capability | Supported | Notes |
|---|:---:|---|
| `delayed` (delayed delivery) | ✅ | Native `DelaySeconds`, **up to 15 minutes** |
| `priority` | ❌ | SQS has no message priority |
| `retries` | ✅ | Redelivery with an attempt counter |
| `backoff` | ✅ | `DelaySeconds` between attempts (capped at 15 min) |

A `delay` above **900s (15 min)** throws `SqsDelayTooLongError` instead of silently truncating it. And since the driver declares `priority: false`, a dispatch with priority is caught by `@basaltkit/queue`'s `onUnsupported` policy.

## How it works

- The job is sent to the `emails` queue with attributes (`x-basalt-job`, `x-basalt-attempt`, `x-basalt-attempts`).
- The worker long-polls (`ReceiveMessage`), runs the handler, and deletes the message (`DeleteMessage`) on success.
- On failure: if attempts remain, it redelivers with `DelaySeconds` (the backoff, capped at 15 min) and deletes the original; if attempts are exhausted, it sends the message to the **dead-letter queue** `emails-dead` (configurable suffix) and deletes the original.

> You must create the SQS queues (main and dead-letter) beforehand and map them in the `queueUrl` resolver — including the `<queue><deadSuffix>`.

## API reference

### `new SqsQueueDriver(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `queueUrl` | `(queue: string) => string` | — (required) | Maps a queue name to its SQS URL. Must also resolve the dead-letter queue. |
| `region` | `string` | (SDK) | AWS region. |
| `deadSuffix` | `string` | `'-dead'` | Suffix for the dead-letter queue name. |
| `waitTimeSeconds` | `number` | `20` | Long-poll duration. |
| `visibilityTimeout` | `number` | `30` | Visibility timeout while the message is being processed. |
| `api` | `SqsApi` | AWS SDK | Injectable API — used in tests without AWS. |

Exported constants/errors: `SQS_MAX_DELAY_SECONDS` (900) and `SqsDelayTooLongError`.

## How it connects to other modules

- **`@basaltkit/queue`** — this is a driver for that package; the jobs API comes from there.
- Sibling drivers: [`@basaltkit/queue-rabbitmq`](https://www.npmjs.com/package/@basaltkit/queue-rabbitmq) and [`@basaltkit/queue-kafka`](https://www.npmjs.com/package/@basaltkit/queue-kafka).
