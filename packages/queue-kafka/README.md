# @machize/queue-kafka

**Apache Kafka** driver for [`@machize/queue`](https://www.npmjs.com/package/@machize/queue): runs your jobs by producing and consuming messages on Kafka topics, without changing your job code. You need this package when your data platform is already built on Kafka and you want to process background work on the same infrastructure.

## What this module solves

`@machize/queue` defines **jobs** in an abstract way and picks the backend via a *driver*. This package provides a driver that talks to **Kafka**: jobs are produced to a topic and consumed by a *consumer group*.

`defineJob`, `dispatch`, the workers and context propagation all stay the same — you only swap the driver.

## Installation

```bash
pnpm add @machize/queue-kafka kafkajs
```

`kafkajs` is a **peer dependency**. You need a reachable Kafka cluster.

## Getting started in 5 minutes

```ts
import { createApp } from '@machize/core'
import { queuePlugin, defineJob } from '@machize/queue'
import { KafkaQueueDriver } from '@machize/queue-kafka'

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

Since the driver **declares** this, a job that requests `delay` or `priority` is caught by `@machize/queue`'s `onUnsupported` policy:

```ts
queuePlugin({ driver: new KafkaQueueDriver({ brokers }), onUnsupported: 'throw' })
await Job.dispatch(payload, { delay: '5m' }) // → throws UnsupportedJobOptionError
// with onUnsupported: 'warn' (default) → warns once and runs immediately
```

> If what you need is *streaming*/pub-sub (rather than jobs with retry/delay), the natural fit in Machize is usually `@machize/events`, not `@machize/queue`.

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
| `clientId` | `string` | `'machize'` | Kafka client id. |
| `groupId` | `string` | `'machize-queue'` | Workers' consumer group. |
| `retrySuffix` | `string` | `'.retry'` | Suffix for the retry topic. |
| `deadSuffix` | `string` | `'.dead'` | Suffix for the dead-letter topic. |
| `client` | `KafkaClient` | kafkajs | Injectable client — used in tests without a broker. |

Implements the `QueueDriver` contract from `@machize/queue`.

## How it connects to other modules

- **`@machize/queue`** — this is a driver for that package; the jobs API comes from there.
- Sibling drivers: [`@machize/queue-rabbitmq`](https://www.npmjs.com/package/@machize/queue-rabbitmq) and [`@machize/queue-sqs`](https://www.npmjs.com/package/@machize/queue-sqs).
