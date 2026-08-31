<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/queue-bullmq

**BullMQ/Redis** driver and plugin for [`@basaltkit/queue`](https://www.npmjs.com/package/@basaltkit/queue): the default production backend for Basalt jobs. Reach for it when you want durable background work with retries, delays and priorities, and you already run (or are happy to run) a Redis server.

## What this module solves

`@basaltkit/queue` defines **jobs** abstractly — `defineJob`, `dispatch`, workers, context propagation — and leaves the backend to a *driver*. This package is the Redis one, built on [BullMQ](https://docs.bullmq.io/).

It is the most capable of the bundled drivers: alone among them it supports **delayed** delivery, **priority**, **retries** and **backoff** all at once, and it is the only one that can **list jobs without consuming them** — which is what makes `queue:jobs`, `manager.list()` and "did my job actually run?" possible.

## Installation

```bash
pnpm add @basaltkit/queue @basaltkit/queue-bullmq bullmq
```

`bullmq` is a **peer dependency**: you install it explicitly, which is what keeps it out of the trees of apps running RabbitMQ, SQS, Kafka or the sync driver. You also need an accessible **Redis** server — that is where the queues live.

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { defineJob } from '@basaltkit/queue'
import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'

const SendWelcome = defineJob({
  name: 'send-welcome',
  queue: 'welcome',
  handle: async ({ userId }: { userId: string }) => {
    await mailer.sendWelcome(userId)
  },
})

const app = await createApp({
  plugins: [
    bullmqQueuePlugin({
      connection: process.env.REDIS_URL!,               // redis:// or rediss:// (TLS inferred)
      jobs: [SendWelcome],                              // jobs this process produces and/or runs
      workers: [{ queue: 'welcome', concurrency: 5 }],  // omit in a producer-only process
    }),
  ],
}).boot()

await SendWelcome.dispatch({ userId: 'u-1' })
```

`bullmqQueuePlugin` takes everything `queuePlugin` does (`jobs`, `workers`, `onUnsupported`, `removeOnComplete`, `removeOnFail`) *plus* the driver's own options below. Swapping backend is swapping that one import — the job code never changes.

## API reference

### `bullmqQueuePlugin(options)`

The plugin. Builds a `BullmqQueueDriver` and hands it to `queuePlugin`, so the manager lands under the `QUEUE` token exactly as it would with any other backend.

Building the driver happens when the app is **defined**, which is safe because the constructor performs no I/O: it parses the connection string and stores your handlers, while the underlying `Queue`/`Worker` objects — and therefore every Redis socket — are created lazily on first use. The one visible consequence is welcome: a malformed connection string throws at definition time rather than at the first dispatch.

### `new BullmqQueueDriver(options: BullmqDriverOptions)`

The driver on its own, for the rarer cases — sharing one driver between plugins, wrapping it, or testing it directly.

```ts
import { queuePlugin } from '@basaltkit/queue'
import { BullmqQueueDriver } from '@basaltkit/queue-bullmq'

queuePlugin({ driver: new BullmqQueueDriver({ connection: process.env.REDIS_URL! }), jobs, workers })
```

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `connection` | `string \| ConnectionOptions` | Yes | — | Redis URL (`redis://…` / `rediss://…`, TLS inferred) or ioredis options. |
| `onError` | `(error, { queue, source: 'worker' \| 'queue' }) => void` | No | `console.error` with context | See [Failure hooks](#failure-hooks). |
| `onJobFailed` | `({ queue, job, jobId?, error }) => void` | No | `console.error` with context | See [Failure hooks](#failure-hooks). |

### Capabilities

| `delayed` | `priority` | `retries` | `backoff` |
| :---: | :---: | :---: | :---: |
| ✅ | ✅ | ✅ | ✅ |

The full set — so `dispatch(job, payload, { delay: '5m', priority: 5 })` is honoured natively and `onUnsupported` never fires. This is the driver the other three are compared against.

### Inspection: `list()` and `queue:jobs`

Redis keeps finished jobs (subject to retention), so this driver can read them **without consuming them** — the reason it implements the optional `list()` capability that the broker drivers deliberately omit:

```bash
basalt queue:stats --queue welcome   # waiting / active / completed / failed / delayed
basalt queue:jobs  --queue welcome   # id / name / state / attempts / age, newest first
```

`list()` queries one state at a time, capped at `limit` each, so a busy `completed` set cannot starve the others; results are merged newest-first. Job payloads can hold personal data, so they are **hidden by default** — `--payload` is the deliberate opt-in.

A healthy queue shows `waiting: 0`: with a worker running, jobs pass through `waiting`/`active` in milliseconds and come to rest in `completed`. Looking only at `waiting` is the usual reason someone concludes "nothing ran".

### Failure hooks

BullMQ's `Worker` and `Queue` are EventEmitters, and an emitted `'error'` with no listener **crashes the process** under Node's semantics. This driver therefore always attaches one; the options only decide where it goes.

| Hook | Fires when | Default |
|---|---|---|
| `onError` | Infrastructure fault — Redis down, a connection dropped. `source` tells you whether it came from a worker or a producer-side queue. | `console.error` with context, prefix `[basalt:queue]` |
| `onJobFailed` | A job exhausted its retries and is permanently failed. | `console.error` with context |

Both default to observable-and-never-fatal rather than silent. Without `onJobFailed`, a permanently failed job is only visible by polling `queue:stats`.

```ts
bullmqQueuePlugin({
  connection: process.env.REDIS_URL!,
  jobs,
  workers,
  onError: (error, { queue, source }) => logger.error({ err: error, queue, source }, 'queue infra error'),
  onJobFailed: ({ queue, job, jobId, error }) => alertDeadJob(queue, job, jobId, error),
})
```

### Job retention

Finished jobs stay in Redis so you can inspect and retry them. Completed jobs keep the last **1000** by default; failed jobs are kept **forever**, which means that set grows unbounded unless you cap it. Set `removeOnComplete` / `removeOnFail` on the plugin for a global default, or on `defineJob` per job.

## How it connects to other modules

- **`@basaltkit/queue`** — this is a driver for that package; the entire job API comes from there.
- See also the sibling drivers: [`@basaltkit/queue-rabbitmq`](https://www.npmjs.com/package/@basaltkit/queue-rabbitmq), [`@basaltkit/queue-sqs`](https://www.npmjs.com/package/@basaltkit/queue-sqs) and [`@basaltkit/queue-kafka`](https://www.npmjs.com/package/@basaltkit/queue-kafka), and the [Queues & Jobs](https://basaltkit-docs.pages.dev/guide/queues) guide.
