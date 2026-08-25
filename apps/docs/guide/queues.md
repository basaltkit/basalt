# Queues & jobs

`@basaltkit/queue` runs work in the background through a small, driver-agnostic
core. You define typed jobs, dispatch them from anywhere, and workers process
them — on Redis (BullMQ) in production, inline in dev/test, or on RabbitMQ,
Kafka, or Amazon SQS through a driver package. The backend is one line to swap;
your jobs never change.

[[toc]]

## Define a job

```ts
import { defineJob } from '@basaltkit/queue'
import { z } from 'zod'

export const SendWelcome = defineJob({
  name: 'send-welcome',
  queue: 'welcome',                 // which queue/worker handles it (default 'default')
  schema: z.object({ userId: z.string() }),
  attempts: 3,                      // retry up to 3 times
  backoff: { type: 'exponential', delay: '30s' },
  async handle({ userId }) {
    // ... do the work
  },
})
```

The `schema` makes the payload type-safe end to end — `handle`'s argument and
`dispatch`'s payload are both inferred from it, and the payload is validated on
dispatch.

## Register it

`queuePlugin` registers a `QueueManager` under the `QUEUE` token, starts the
declared workers on `boot`, and closes everything on `shutdown`:

```ts
import { createApp } from '@basaltkit/core'
import { queuePlugin } from '@basaltkit/queue'
import { SendWelcome } from './jobs/send-welcome.js'

const app = await createApp({
  plugins: [
    queuePlugin({
      connection: process.env.REDIS_URL,     // → BullMQ driver. Omit for the sync driver.
      jobs: [SendWelcome],                    // jobs this process produces and/or runs
      workers: [{ queue: 'welcome', concurrency: 5 }], // start a worker for this queue
    }),
  ],
}).boot()
```

With no `connection` (and no `driver`), the plugin uses the **sync** driver:
`dispatch` runs `handle` inline in the same process — no Redis, ideal for dev and
tests. A worker's `queue` **must match** a job's `queue`, or the job lands in the
backend but nothing consumes it.

### Producer and worker in separate processes

In production the API process usually only **produces** (calls `dispatch`) while
a separate process **consumes**. Both must register the **same jobs** — the
worker needs each job's `handle`, and a job that reaches a worker that hasn't
registered it throws `UnknownJobError`. Only the consumer declares `workers`:

```ts
// API process — produces only (no `workers`)
queuePlugin({ jobs: [SendWelcome, GenerateInvoice], connection: process.env.REDIS_URL })

// worker process — consumes
queuePlugin({
  jobs: [SendWelcome, GenerateInvoice],
  connection: process.env.REDIS_URL,
  workers: [
    { queue: 'welcome', concurrency: 5 },
    { queue: 'billing', concurrency: 2 },
  ],
})
```

## Dispatch

```ts
import { ctx } from '@basaltkit/core'
import { QUEUE } from '@basaltkit/queue'

await ctx().container.get(QUEUE).dispatch(SendWelcome, { userId: 'u-1' })

// or straight off the job (once it's registered):
await SendWelcome.dispatch({ userId: 'u-1' }, { delay: '5m', priority: 5 })
```

`dispatch` returns as soon as the job is enqueued. Request context
(`requestId`, `tenantId`, …) is captured and restored inside the worker.

## Drivers

The backend is chosen by the driver. `connection` picks BullMQ; pass a `driver`
to use another backend.

| Driver | Package | `delayed` | `priority` | `retries` | `backoff` |
| --- | --- | :---: | :---: | :---: | :---: |
| **BullMQ** (Redis) | `@basaltkit/queue` | ✅ | ✅ | ✅ | ✅ |
| **RabbitMQ** | `@basaltkit/queue-rabbitmq` | ✅ | ✅ | ✅ | ✅ |
| **Amazon SQS** | `@basaltkit/queue-sqs` | ✅ (≤15 min) | ❌ | ✅ | ✅ |
| **Kafka** | `@basaltkit/queue-kafka` | ❌ | ❌ | ✅ | ❌ |
| **Sync** (dev/test) | `@basaltkit/queue` | ❌ | ❌ | ✅ | ❌ |

```ts
import { RabbitmqQueueDriver } from '@basaltkit/queue-rabbitmq'
queuePlugin({ driver: new RabbitmqQueueDriver({ url: process.env.AMQP_URL! }), jobs, workers })

import { SqsQueueDriver } from '@basaltkit/queue-sqs'
queuePlugin({ driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => QUEUE_URLS[q] }), jobs, workers })

import { KafkaQueueDriver } from '@basaltkit/queue-kafka'
queuePlugin({ driver: new KafkaQueueDriver({ brokers: ['localhost:9092'] }), jobs, workers })
```

## Capability checks

Backends differ — Kafka has no message priority, SQS caps delays at 15 minutes,
the sync driver runs inline. Rather than silently drop an option a backend can't
honor, each driver declares its `capabilities` and the queue checks every
dispatch against them.

```ts
queuePlugin({
  driver: new KafkaQueueDriver({ brokers }),
  onUnsupported: 'throw', // 'warn' (default) · 'throw' · 'ignore'
})

// a delayed job on Kafka:
await Job.dispatch(payload, { delay: '5m' })
//  onUnsupported: 'warn'  → logs once, runs immediately
//  onUnsupported: 'throw' → throws UnsupportedJobOptionError
//  onUnsupported: 'ignore'→ silently proceeds (legacy)
```

Use `'throw'` in production for a hard guarantee; the default `'warn'` never
breaks a dev run but never hides a dropped option either.

## Job retention in Redis

With the BullMQ driver, finished jobs stay in Redis so you can inspect and retry
them. By default **completed** jobs keep the last **1000**, and **failed** jobs are
kept **forever** — which means the failed set can grow unbounded. Control it with
`removeOnComplete` / `removeOnFail`, globally on `queuePlugin` or per job:

```ts
// Global default for every job
queuePlugin({
  connection: process.env.REDIS_URL,
  jobs: [SendWelcome],
  removeOnComplete: { age: '7d' },   // keep completed for 7 days
  removeOnFail: { age: '14d' },      // failed no longer grow forever
})

// Per job — overrides the global default
defineJob({
  name: 'email.welcome',
  removeOnComplete: true,             // remove as soon as it finishes
  removeOnFail: { count: 500 },       // keep the last 500 failures
  handle: () => {},
})
```

Each option accepts `true` (remove on finish), `false` (keep all), a number (keep
that many most-recent), or `{ age, count }` where `age` is a duration like `'14d'`.
Left unset, the defaults above apply. The **sync** driver ignores retention — it
stores nothing. (The queue's own `bull:<queue>:*` structure keys always exist once
the queue is created; that's BullMQ, not leftover jobs.)

## Run domain events on the queue

`queuedOn` bridges `@basaltkit/events` → queue: `emit` just enqueues a job, and
the handler runs on the worker with retries and restored context. It returns the
unsubscribe function; the created job is named `listener:<event>`.

```ts
import { EventBus, defineEvent } from '@basaltkit/events'
import { QUEUE, queuedOn } from '@basaltkit/queue'
import { ctx } from '@basaltkit/core'
import { z } from 'zod'

const bus = new EventBus()
const manager = ctx().container.get(QUEUE)
const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

const unsubscribe = queuedOn(bus, manager, OrderCreated, async ({ orderId }) => {
  // runs on the worker, with the driver's retry/backoff
}, { queue: 'orders', attempts: 3 })

await bus.emit(OrderCreated, { orderId: 'o-1' })
```

## Errors

| Class | Code | When |
| --- | --- | --- |
| `JobValidationError` | `JOB_INVALID` | Payload fails the job's `schema` (thrown at `dispatch`; has `.job` and `.issues`) |
| `JobNotRegisteredError` | `QUEUE_JOB_NOT_REGISTERED` | `dispatch` before the job was registered with a manager (add it to `jobs`) |
| `UnknownJobError` | `QUEUE_UNKNOWN_JOB` | A job reached a worker that hasn't registered it (producer/worker job lists differ) |
| `UnsupportedJobOptionError` | — | A dispatch requested an option the driver can't honor, under `onUnsupported: 'throw'` |

## Writing a driver

A driver is any object implementing the `QueueDriver` seam — four methods and
an optional capability declaration:

```ts
import type { QueueDriver, DriverCapabilities, JobExecutor, AddJobOptions } from '@basaltkit/queue'

export class MyQueueDriver implements QueueDriver {
  readonly name = 'my-backend'
  // Declare what the backend honors. Omit it and the driver is assumed fully
  // capable (back-compat) — but then nothing is checked, so prefer declaring it.
  readonly capabilities: DriverCapabilities = { delayed: false, priority: false, retries: true, backoff: false }

  private executor: JobExecutor | undefined

  // The QueueManager calls this once, handing you how to run a received job.
  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  // Enqueue. `options` carries attempts/backoff/delayMs/priority — honor what
  // your `capabilities` claim; the QueueManager has already applied its
  // onUnsupported policy for the rest.
  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    // publish { jobName, data, options } to your backend
  }

  // Start consuming `queue`. For each received job call
  // `this.executor(jobName, data)`; on success remove it, on failure retry or
  // dead-letter per your backend's model.
  startWorker(queue: string, options?: { concurrency?: number }): void {
    // consume → await this.executor?.(jobName, data)
  }

  async close(): Promise<void> {
    // disconnect producers/consumers
  }
}
```

Then plug it in:

```ts
queuePlugin({ driver: new MyQueueDriver(), jobs, workers })
```

**Guidance for a faithful driver:**

- **Be honest in `capabilities`.** If the backend can't defer a message, set
  `delayed: false` — the compatibility check turns a silent drop into a loud
  one. The bundled drivers are a reference: [`@basaltkit/queue-rabbitmq`][rmq]
  (delay + retries via a dead-letter queue), [`@basaltkit/queue-sqs`][sqs]
  (native delay, no priority), [`@basaltkit/queue-kafka`][kafka] (a log, so no
  delay/priority; retries via a retry topic).
- **Carry retry state in the message.** `attempts`/`backoff` come from `add`;
  stamp the current attempt into message metadata so the worker knows when to
  retry versus dead-letter.
- **Make the client injectable.** Each bundled driver takes an injectable
  connector (`connect`/`client`/`api`), so its retry and dead-letter logic is
  unit-tested without a running broker. Do the same and your driver is testable
  in CI.

[rmq]: https://github.com/basaltkit/basalt/tree/main/packages/queue-rabbitmq
[sqs]: https://github.com/basaltkit/basalt/tree/main/packages/queue-sqs
[kafka]: https://github.com/basaltkit/basalt/tree/main/packages/queue-kafka

## See also

- [Notes SaaS cookbook](/cookbook/notes-saas) — queues wired into a real app
  (BullMQ + Redis, mailer off the request).
