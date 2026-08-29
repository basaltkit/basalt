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
tests. Know its semantics before relying on it: it is **at-most-once** (a job
that exhausts its inline retries is lost), handler errors **reject the
`dispatch()` call** (your request fails instead of a background retry), and it
is not meant for production — a production deploy that falls back to it without
a Redis `connection` logs a warning at boot (pass `driver: new SyncQueueDriver()`
to opt in deliberately). A worker's `queue` **must match** a job's `queue`, or
the job lands in the backend but nothing consumes it.

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

Every bundled driver follows the same observability norm: **infrastructure
faults — broker down, a worker's connect failing at boot, a retry re-publish
failing — surface through an `onError`-family option with a contextual
`console.error` default (prefix `[basalt:queue]`)**. They are never unhandled
rejections that kill the process, and never silent.

### BullMQ (Redis)

`connection` on `queuePlugin` is shorthand for this driver. Both failure
channels are configurable **right there** — you do not have to hand-build the
driver to get observability:

```ts
queuePlugin({
  connection: process.env.REDIS_URL!,
  jobs,
  workers,
  onError: (error, { queue, source }) => log.error({ queue, source, error }, 'queue infra error'),
  onJobFailed: ({ queue, job, jobId, error }) => alertDeadJob(queue, job, jobId, error),
})
```

`onError`/`onJobFailed` on `queuePlugin` are forwarded to the driver built from
`connection`. They are **ignored when you pass your own `driver`** — configure
them on the driver instead, which is also how you reach any option the shorthand
doesn't surface:

```ts
import { BullmqQueueDriver } from '@basaltkit/queue'

queuePlugin({
  driver: new BullmqQueueDriver({
    connection: process.env.REDIS_URL!,
    onError: (error, { queue, source }) => log.error({ queue, source, error }, 'queue infra error'),
  }),
  jobs,
  workers,
})
```

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `connection` | `string \| ConnectionOptions` | — (required) | Redis URL (`redis://`/`rediss://`, TLS inferred) or ioredis options. |
| `onError` | `(error, { queue, source: 'worker' \| 'queue' }) => void` | `console.error` with context | BullMQ emits infra errors (Redis down) as EventEmitter `'error'` events — unhandled, they **crash the process**. The driver always attaches a listener; this option routes it to your logger/alerting. |
| `onJobFailed` | `({ queue, job, jobId?, error }) => void` | `console.error` with context | Fires when a job exhausts its retries (BullMQ `'failed'`). Without it, permanently failed jobs were only visible by polling `queue:stats`. |

### RabbitMQ

```ts
import { RabbitmqQueueDriver } from '@basaltkit/queue-rabbitmq'

queuePlugin({ driver: new RabbitmqQueueDriver({ url: process.env.AMQP_URL! }), jobs, workers })
```

Retries and backoff use a per-queue delay queue (`<queue>.delay`) whose messages
TTL-expire back into the main queue; exhausted jobs land in `<queue>.dead`.
Priority uses `x-max-priority`. Delivery safety: the driver prefers a
**publisher-confirm channel** and only acks a message after the broker has
confirmed any retry/dead-letter re-publish — acking before the publish is
confirmed would be a silent job-loss window. `close()` drains in-flight handlers
first; anything unfinished stays unacked, so the broker redelivers it.

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `url` | `string` | — (required) | AMQP URL, e.g. `amqp://user:pass@host:5672`. |
| `onError` | `(error, { source: 'connection' \| 'channel' }) => void` | `console.error` with context | amqplib surfaces broker faults as EventEmitter `'error'` events — unhandled, they **crash the process**. Also receives a worker's connect/consume failure at boot (otherwise the app would report healthy with zero workers) and a failed re-publish/ack after a job failure (the durable copy stays on the broker and is redelivered). |
| `maxPriority` | `number` | `10` | `x-max-priority` for the priority queues. |
| `drainTimeoutMs` | `number` | `10_000` | How long `close()` waits for in-flight handlers so their acks land on a live channel. Past it, unfinished jobs stay unacked and are redelivered — bounded shutdown without job loss. |
| `connect` | `AmqpConnect` | amqplib | Injectable connector — tests run without a broker. |

::: tip Mixed delays at scale
The delay queue relies on per-message TTL, which only releases a message at the
queue head (head-of-line blocking). For many different delays on one queue,
prefer RabbitMQ's delayed-message-exchange plugin.
:::

### Amazon SQS

```ts
import { SqsQueueDriver } from '@basaltkit/queue-sqs'

queuePlugin({ driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => QUEUE_URLS[q] }), jobs, workers })
```

SQS has native per-message delay (≤ 15 minutes) but no priority. Retries and
backoff are handled at the app level for parity with the other drivers: a failed
message is re-sent with an incremented attempt and a `DelaySeconds` backoff
(clamped to 15 min); an exhausted job goes to the dead-letter queue
(`<queue><deadSuffix>`). The `queueUrl` resolver must map every queue name —
**including the DLQ names** — to its SQS URL.

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `queueUrl` | `(queue: string) => string` | — (required) | Resolves queue names (and `<queue>-dead`) to SQS URLs. |
| `region` | `string` | SDK default | AWS region for the default client. |
| `deadSuffix` | `string` | `'-dead'` | Suffix of the dead-letter queue's name. |
| `waitTimeSeconds` | `number` | `20` | Long-poll wait per receive. |
| `visibilityTimeout` | `number` | `30` | How long a received message stays hidden while processed. |
| `onError` | `(error, { queue }) => void` | `console.error` with context | A receive call failed (network, credentials, queue deleted). Without it the poller used to retry immediately and silently — a hot spin with zero log output on a persistent fault. |
| `errorPauseMs` | `number` | `1000` | Pause between consecutive failed receives — bounds the retry rate against a broken endpoint. |
| `api` | `SqsApi` | AWS SDK | Injectable API — tests run without AWS. |

A user-requested `delay` over 15 minutes throws `SqsDelayTooLongError` at
dispatch (a *backoff* delay is clamped instead, so retries never throw).

### Kafka

```ts
import { KafkaQueueDriver } from '@basaltkit/queue-kafka'

queuePlugin({ driver: new KafkaQueueDriver({ brokers: ['localhost:9092'] }), jobs, workers })
```

Kafka is a log, not a task queue, and the driver is deliberately honest about
that: no `delayed`, no `priority`, no `backoff` (Kafka cannot defer a message).
Retries publish to a retry topic (`<queue>.retry`) the worker also consumes;
exhausted jobs go to `<queue>.dead`. Worker `concurrency` maps to
`partitionsConsumedConcurrently`, so effective parallelism is bounded by the
topic's partition count.

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `brokers` | `string[]` | — (required) | Kafka bootstrap brokers. |
| `clientId` | `string` | `'basalt'` | kafkajs client id. |
| `groupId` | `string` | `'basalt-queue'` | Consumer group workers join. |
| `retrySuffix` | `string` | `'.retry'` | Suffix of the retry topic. |
| `deadSuffix` | `string` | `'.dead'` | Suffix of the dead-letter topic. |
| `onError` | `(error, { source: 'consumer' \| 'producer', queue? }) => void` | `console.error` with context | `source: 'consumer'`: the worker's connect/subscribe/run failed at boot — without this the app reports healthy with **zero workers** and the floating rejection is process-fatal. `source: 'producer'`: a retry/dead-letter re-publish failed inside the consume callback (see below). |
| `client` | `KafkaClient` | kafkajs | Injectable client — tests run without a broker. |

When a failed job's re-publish to the retry/dead topic itself fails (producer or
broker outage), the driver reports it through `onError` and then **rethrows so
the message's offset is not committed** — Kafka redelivers the message
(at-least-once) instead of the job silently vanishing. Expect redelivery during
a producer outage, never loss. (RabbitMQ keeps the message unacked for the same
reason; not committing the offset is Kafka's equivalent.)

### Sync (dev/test)

The inline driver's semantics are covered [above](#register-it): at-most-once,
handler errors reject `dispatch()`, and an implicit production fallback warns at
boot. For test assertions it records every execution in `driver.executed`
(`{ queue, jobName, attempts }`), capped at the **1000** most recent entries
(oldest evicted) so a long-lived process on this driver cannot leak memory.

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
| `SqsDelayTooLongError` | — | A `delay` over SQS's 15-minute maximum (`@basaltkit/queue-sqs`, thrown at `dispatch`) |

## Failure modes & troubleshooting

| If you see | It means | Do |
| --- | --- | --- |
| Boot warning `[basalt:queue] No 'connection' (Redis) configured…` in production | The plugin silently fell back to the inline sync driver: at-most-once, no background retries, handler errors fail the dispatching request | Configure a Redis `connection`, or pass `driver: new SyncQueueDriver()` to opt in deliberately |
| `dispatch()` rejects with your handler's error | Sync-driver semantics: errors propagate to the dispatcher by design (a broker driver would return immediately and retry in background) | Expected in dev/test; use a broker driver where you need background retries |
| A job is enqueued but never runs | No worker declared for the job's `queue`, or the worker `queue` name doesn't match the job's | Align `defineJob({ queue })` with `workers: [{ queue }]` |
| `UnknownJobError` in worker logs | The job reached a worker that hasn't registered it — producer and worker `jobs` lists differ | Register the same `jobs` array in both processes |
| Repeated `[basalt:queue] bullmq worker error (queue "…")` | Redis infra fault (connectivity, failover); BullMQ reconnects on its own | Route `onError` to alerting; check Redis |
| `[basalt:queue] job "…" on queue "…" failed permanently` | The job exhausted its `attempts`; it stays in the failed set (default retention keeps all) | Inspect, fix the cause, `basalt queue:retry --queue <q>`; route `onJobFailed` to alerting |
| `UnsupportedJobOptionError` at dispatch | The driver can't honor a requested option (e.g. `delay` on Kafka) under `onUnsupported: 'throw'` | Drop the option or switch drivers |
| `SqsDelayTooLongError` at dispatch | A `delay` beyond SQS's 15-minute cap | Cap the delay, or use BullMQ/RabbitMQ for long delays |
| `[basalt:queue] kafka consumer error (queue "…")` at boot | The worker's broker connect/subscribe failed — the process stays up but consumes **nothing** | Fix brokers/network and restart the worker; alert on this log line |
| The same Kafka message is redelivered repeatedly, with `[basalt:queue] kafka producer error` alongside | A failed job's retry/dead-letter re-publish is failing, so the driver refuses to commit the offset — redelivery instead of silent loss | Restore the producer/broker; the backlog drains itself |
| `[basalt:queue] rabbitmq channel error` after a job failure | The retry re-publish wasn't confirmed or the ack failed; nothing was acked, so the broker redelivers the durable copy | Check broker health; no action needed for the job itself |

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

- [Scheduled tasks](/guide/scheduler) — dispatch jobs on a cron schedule with
  `schedule.job(...)`.
- [Notes SaaS cookbook](/cookbook/notes-saas) — queues wired into a real app
  (BullMQ + Redis, mailer off the request).
