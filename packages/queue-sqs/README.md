<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

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
import { defineJob } from '@basaltkit/queue'
import { sqsQueuePlugin } from '@basaltkit/queue-sqs'

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
    sqsQueuePlugin({
      region: 'eu-west-1',
      queueUrl: (q) => QUEUE_URLS[q]!,
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

### Inspection: no `list()` / `queue:jobs`

This driver deliberately does **not** implement the queue's optional
`list(queue, options)` capability, so `basalt queue:jobs` reports it as
unsupported rather than faking it.

`ReceiveMessage` is the only way to read an SQS message, and it is destructive
in every way that matters: it starts the **visibility timeout** (hiding the
message from real workers) and increments `ApproximateReceiveCount`, which is
exactly what a redrive policy uses to move a message to the dead-letter queue.
A "peek" implemented this way could push jobs to the DLQ *just for looking at
them*. Use the SQS console's poll-for-messages view when you must inspect, and
the `<queue>-dead` queue for exhausted jobs.

## How it works

- The job is sent to the `emails` queue with attributes (`x-basalt-job`, `x-basalt-attempt`, `x-basalt-attempts`).
- The worker long-polls (`ReceiveMessage`), runs the handler, and deletes the message (`DeleteMessage`) on success.
- On failure: if attempts remain, it redelivers with `DelaySeconds` (the backoff, capped at 15 min) and deletes the original; if attempts are exhausted, it sends the message to the **dead-letter queue** `emails-dead` (configurable suffix) and deletes the original.

**You must create the SQS queues** (main and dead-letter) beforehand and map them in the `queueUrl` resolver — including the `<queue><deadSuffix>` one.

## API reference

### `new SqsQueueDriver(options)`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `queueUrl` | `(queue: string) => string` | — (required) | Maps a queue name to its SQS URL. Must also resolve `<queue><deadSuffix>` — the driver calls it for the DLQ too. |
| `region` | `string` | (SDK's chain) | AWS region passed to `SQSClient`. Omit to let the standard AWS resolution decide. |
| `deadSuffix` | `string` | `'-dead'` | Suffix appended to the queue name to derive the dead-letter queue. |
| `waitTimeSeconds` | `number` | `20` | Long-poll duration per `ReceiveMessage`. 20 is SQS's maximum and the cheapest setting — lower it only if you need a faster shutdown. |
| `visibilityTimeout` | `number` | `30` | How long a received message stays hidden from other consumers. Must exceed your slowest handler, or the job is delivered twice. |
| `onError` | `(error: unknown, info: { queue: string }) => void` | `console.error` with the queue | A `ReceiveMessage` call failed — see below. |
| `errorPauseMs` | `number` | `1000` | Pause after a failed receive before polling again. This is what keeps a persistent fault from becoming a CPU-burning hot spin against the SQS endpoint. |
| `api` | `SqsApi` | `@aws-sdk/client-sqs` | Injectable API (`sendMessage` / `receiveMessages` / `deleteMessage`) — tests pass a fake so no AWS is needed. |

The driver implements `add`, `startWorker`, `setExecutor`, `close` and `capabilities`; it does
**not** implement the optional `stats` / `retryFailed`, so `basalt queue:stats` and
`basalt queue:retry` report the operation as unsupported. Also exported:
`SQS_MAX_DELAY_SECONDS` (`900`), `SqsDelayTooLongError`, and the `SqsApi` / `SqsMessage` types.

### Failure hooks

`onError` is the only callback and it fires on exactly one thing: a failed **receive**
(credentials expired, network partition, queue deleted, throttling). The default is
`console.error`, so a persistent fault is always visible.

After reporting, the poller waits `errorPauseMs` and polls again — it never gives up, because a
transient AWS error must not silently stop the worker. There is no `onJobFailed`: a job that
exhausts `attempts` is sent to `<queue><deadSuffix>`, which *is* the report. Alarm on that
queue's `ApproximateNumberOfMessagesVisible`.

Handler failures never reach `onError` — they are caught and turned into a redelivery (with the
backoff as `DelaySeconds`) or a DLQ send, after which the original is deleted.

If *that* re-send or the delete itself throws, the exception escapes the message loop and ends
**this poller**. The original message was never deleted, so SQS makes it visible again after
`visibilityTimeout` and another poller picks it up — the job is not lost. But with
`concurrency: 1` there is no other poller, so the worker stops consuming that queue until the
process restarts. Run more than one poller per queue if you need the worker to survive a
transient send failure, and alarm on queue depth.

### Exported errors

| Error | Code | When |
|---|---|---|
| `SqsDelayTooLongError` | — (plain `Error`, `name: 'SqsDelayTooLongError'`) | A **user-supplied** `dispatch(payload, { delay })` exceeded SQS's 900 s ceiling. Thrown from `add()`, so the dispatch fails loudly instead of being silently truncated. |
| `UnsupportedJobOptionError` | `QUEUE_UNSUPPORTED_OPTION` | From `@basaltkit/queue`, when a `priority` dispatch meets `onUnsupported: 'throw'` (SQS declares `priority: false`). |

A **backoff** delay that computes above 900 s is clamped to 900 s rather than throwing — the
retry is not something the caller asked for at that moment, so failing it would be worse than
retrying sooner.

### Hard limits

Attempt counters travel in message attributes, so the consumer clamps the `x-basalt-attempts` it
reads to at most **50** — a crafted message cannot drive an unbounded retry loop.

### The plugin, and the driver underneath it

`sqsQueuePlugin` is the one-line path: it builds the driver and hands it to
`queuePlugin` from `@basaltkit/queue`, so it accepts every core option
(`jobs`, `workers`, `onUnsupported`, `removeOnComplete`, `removeOnFail`)
alongside the driver options documented above. Every backend ships a plugin of
this shape, so no backend is privileged in the core's API.

`SqsQueueDriver` stays exported for the rarer cases — sharing one driver
between plugins, wrapping it, or testing it directly:

```ts
import { queuePlugin } from '@basaltkit/queue'
import { SqsQueueDriver } from '@basaltkit/queue-sqs'

queuePlugin({ driver: new SqsQueueDriver({ /* … */ }), jobs, workers })
```

## How it connects to other modules

- **`@basaltkit/queue`** — this is a driver for that package; the jobs API comes from there.
- Sibling drivers: [`@basaltkit/queue-rabbitmq`](https://www.npmjs.com/package/@basaltkit/queue-rabbitmq) and [`@basaltkit/queue-kafka`](https://www.npmjs.com/package/@basaltkit/queue-kafka).
