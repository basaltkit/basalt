<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/queue-kafka

**Apache Kafka** driver for [`@basaltkit/queue`](https://www.npmjs.com/package/@basaltkit/queue): runs your jobs by producing and consuming messages on Kafka topics, without changing your job code. You need this package when your data platform is already built on Kafka and you want to process background work on the same infrastructure.

## What this module solves

`@basaltkit/queue` defines **jobs** in an abstract way and picks the backend via a *driver*. This package provides a driver that talks to **Kafka**: jobs are produced to a topic and consumed by a *consumer group*.

`defineJob`, `dispatch`, the workers and context propagation all stay the same — you only swap the driver.

## Installation

```bash
pnpm add @basaltkit/queue-kafka kafkajs
```

`kafkajs` is a **peer dependency**. You need a reachable Kafka cluster.

## Getting started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { queuePlugin, defineJob } from '@basaltkit/queue'
import { KafkaQueueDriver } from '@basaltkit/queue-kafka'

const IndexDocument = defineJob<{ id: string }>({
  name: 'index-document',
  queue: 'indexing',
  attempts: 3,
  async handle({ id }) {
    // ... index it
  },
})

const app = await createApp({
  plugins: [
    queuePlugin({
      driver: new KafkaQueueDriver({ brokers: ['localhost:9092'], clientId: 'my-app' }),
      jobs: [IndexDocument],
      workers: [{ queue: 'indexing', concurrency: 4 }],
    }),
  ],
}).boot()

await IndexDocument.dispatch({ id: 'doc-1' })
```

## Being honest about Kafka

Kafka is a **distributed log**, not a *task queue* — and the driver is deliberately honest about that in its `capabilities`:

| Capability | Supported | Why |
|---|:---:|---|
| `delayed` (delayed delivery) | ❌ | Kafka doesn't delay messages. |
| `priority` | ❌ | Kafka has no message priority. |
| `retries` | ✅ | Via a *retry topic* that the worker also consumes. |
| `backoff` | ❌ | No delay between attempts (Kafka doesn't defer). |

Since the driver **declares** this, a job that requests `delay` or `priority` is caught by `@basaltkit/queue`'s `onUnsupported` policy:

```ts
queuePlugin({ driver: new KafkaQueueDriver({ brokers }), onUnsupported: 'throw' })
await Job.dispatch(payload, { delay: '5m' }) // → throws UnsupportedJobOptionError
// with onUnsupported: 'warn' (default) → warns once and runs immediately
```

**If what you need is *streaming*/pub-sub** (rather than jobs with retry/delay), the natural fit in Basalt is usually `@basaltkit/events`, not `@basaltkit/queue`.

### Inspection: no `list()` / `queue:jobs`

This driver deliberately does **not** implement the queue's optional
`list(queue, options)` capability, so `basalt queue:jobs` reports it as
unsupported.

Here the reason is not destructiveness — reading a Kafka topic does not remove
records — but **meaning**. Kafka has no per-message state: there is no
`waiting`/`active`/`completed`/`failed` set, no broker-assigned job id, and no
way to tell a record still to be processed from one processed an hour ago. A
`list()` would return an arbitrary window of the log within retention, dressed
up in job states it invented. That would make the same API mean something
different depending on the driver, which is the coupling this API exists to
remove. Use your Kafka tooling (`kafka-console-consumer`, a UI) plus the
`<topic>.retry` / `<topic>.dead` topics instead.

## How it works

For each queue `t`:

- **`t`** — the main topic where jobs are produced.
- **`t.retry`** — retry topic that the worker also subscribes to; a failed job is re-produced here with the attempt counter incremented.
- **`t.dead`** — dead-letter topic for jobs that exhausted their attempts.

The worker's concurrency is passed as `partitionsConsumedConcurrently` — actual parallelism is limited by the topic's **number of partitions**, not an arbitrary number.

## API reference

### `new KafkaQueueDriver(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `brokers` | `string[]` | — (required) | List of brokers, e.g. `['localhost:9092']`. |
| `clientId` | `string` | `'basalt'` | Kafka client id. |
| `groupId` | `string` | `'basalt-queue'` | Workers' consumer group. |
| `retrySuffix` | `string` | `'.retry'` | Suffix for the retry topic. |
| `deadSuffix` | `string` | `'.dead'` | Suffix for the dead-letter topic. |
| `client` | `KafkaClient` | kafkajs | Injectable client — used in tests without a broker. |
| `onError` | `(error: unknown, info: { source: 'consumer' \| 'producer'; queue?: string }) => void` | contextual `console.error` | The driver's single fault channel — see below. |

Implements the `QueueDriver` contract from `@basaltkit/queue`. It does **not** implement the optional `stats` / `retryFailed`, so `basalt queue:stats` and `basalt queue:retry` report the operation as unsupported — use your Kafka tooling for consumer-group lag instead.

### Failure hooks

`onError` is the only callback, and its default (`console.error` with the source and queue) is
never silent. There is no `onJobFailed`: a job that exhausts `attempts` is produced to
`<topic>.dead`, which *is* the report — monitor that topic.

| `source` | Raised when | What the driver does next |
|---|---|---|
| `'consumer'` | A worker's `connect`/`subscribe`/`run` rejected at boot (broker unreachable, missing topic, bad ACLs). | Reports and stops. Without this the rejection would float and be process-fatal, and the app would report healthy with **zero** workers. |
| `'producer'` | The retry / dead-letter **re-publish itself failed** while handling a failed job. | Reports, then **rethrows** — see below. |

### Redelivery when the DLQ produce fails

The subtle case. A job's handler throws, so the driver tries to re-route the message — to
`<topic>.retry` if attempts remain, otherwise to `<topic>.dead`. If *that* produce also fails
(the producer lost its broker connection, the dead topic doesn't exist, the request timed out),
the failed job exists nowhere but in the message currently being consumed.

kafkajs auto-commits offsets after `eachMessage` **resolves**. So the driver:

1. reports the publish failure through `onError({ source: 'producer', queue })`, then
2. **rethrows** it, so `eachMessage` rejects and the offset is **not** committed.

Kafka then redelivers the same message and the driver tries the whole thing again — at-least-once
rather than a job that quietly evaporated during a producer outage. It is the Kafka equivalent of
RabbitMQ leaving a message unacked.

Two consequences worth planning for:

- **Handlers must be idempotent.** A redelivered message re-runs the handler that already failed,
  and a message whose re-publish succeeded is never redelivered — but a partition stalls on the
  failing message while the producer is down, so ordered downstream work backs up behind it.
- **A normal failure path does commit.** When the re-publish *succeeds*, the failure is
  considered handled: the offset commits and the retry copy carries the incremented
  `x-basalt-attempt` header. Redelivery only happens on the produce failure itself.

### Exported errors

This driver throws no error classes of its own. `UnsupportedJobOptionError`
(`QUEUE_UNSUPPORTED_OPTION`) comes from `@basaltkit/queue` when a `delay`/`priority` dispatch
meets `onUnsupported: 'throw'`; everything else surfaces through `onError`.

### Hard limits

The attempt counters travel in message headers, which any producer on the topic could write, so
the consumer clamps the `x-basalt-attempts` it reads to at most **50**. A crafted message cannot
drive an unbounded retry loop.

## How it connects to other modules

- **`@basaltkit/queue`** — this is a driver for that package; the jobs API comes from there.
- Sibling drivers: [`@basaltkit/queue-rabbitmq`](https://www.npmjs.com/package/@basaltkit/queue-rabbitmq) and [`@basaltkit/queue-sqs`](https://www.npmjs.com/package/@basaltkit/queue-sqs).
