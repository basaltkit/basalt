<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/queue

Job queues for Basalt applications: define declarative "jobs" with Zod validation, run them in the background with BullMQ/Redis in production, and synchronously in development and tests — without changing a line of code.

You need this module when you have work that **must not block the user's request**: sending emails, generating reports, processing images, syncing data, etc.

---

## What this module solves

A **queue** is a waiting list of tasks. Instead of doing the heavy work immediately (and making the user wait), you put the task on the queue and respond right away. A **worker** — a process that may live on another machine — pulls tasks off the queue and runs them, one at a time or several in parallel. Each individual task is called a **job**.

This module gives you three things you'd normally have to build by hand:

1. **Declarative, type-safe jobs** — you define each job once with `defineJob` (name, validation schema, number of attempts) and then call `MyJob.dispatch(data)` anywhere in the application. Data is validated with Zod *before* entering the queue, so invalid data never reaches the worker.
2. **Context propagation** — information from the current request (`requestId`, `tenantId`, `userId`, etc.) automatically travels along with the job and is restored inside the worker. Your logs and tenant checks work in the worker the same way they did in the HTTP request.
3. **Interchangeable drivers** — in production, use **BullMQ** (over Redis, with real retries and delays), or RabbitMQ/SQS/Kafka through a driver package; in development and tests, use the **sync** driver, which runs the job immediately, in the same process, without needing Redis installed. The core itself is backend-neutral: it depends on no broker client.

## Installation

```bash
pnpm add @basaltkit/queue

# plus the backend you run in production — BullMQ/Redis here:
pnpm add @basaltkit/queue-bullmq bullmq
```

The package depends on `@basaltkit/core` and `@basaltkit/events` (installed automatically). For development and tests you need nothing else — the sync driver ships here and has no dependencies.

**Keep this package whichever backend you pick.** It is not one of the backends — it is the contract they all implement, and the package your job code imports: `defineJob`, `dispatch`, the `QUEUE` token, `QueueManager`, workers, context propagation, and the sync driver. A backend package **depends on** it; it never replaces it.

**This package contains no broker client, and no backend is privileged in its API.** Each backend is a separate package that carries its driver *and* a one-line plugin, and declares its client as a peer dependency you install yourself:

| Backend | Package | Plugin | Client |
| --- | --- | --- | --- |
| BullMQ (Redis) | [`@basaltkit/queue-bullmq`](https://www.npmjs.com/package/@basaltkit/queue-bullmq) | `bullmqQueuePlugin` | `bullmq` |
| RabbitMQ | [`@basaltkit/queue-rabbitmq`](https://www.npmjs.com/package/@basaltkit/queue-rabbitmq) | `rabbitmqQueuePlugin` | `amqplib` |
| Amazon SQS | [`@basaltkit/queue-sqs`](https://www.npmjs.com/package/@basaltkit/queue-sqs) | `sqsQueuePlugin` | `@aws-sdk/client-sqs` |
| Kafka | [`@basaltkit/queue-kafka`](https://www.npmjs.com/package/@basaltkit/queue-kafka) | `kafkaQueuePlugin` | `kafkajs` |
| **none** — inline, dev/tests | *(already in this package)* | `queuePlugin` | — nothing |

So an app on SQS never installs (or loads) BullMQ and its ioredis transitive weight. For production with BullMQ you also need an accessible **Redis** server (it stores the queues there).

## Get started in 5 minutes

Step by step to get a job working:

**1. Define the job** (in its own file, e.g. `src/jobs/send-welcome-email.ts`):

```ts
import { defineJob } from '@basaltkit/queue'
import { z } from 'zod'

export const SendWelcomeEmail = defineJob({
  name: 'email.welcome',                       // unique job name
  schema: z.object({ userId: z.string() }),    // shape of the data (validated)
  attempts: 3,                                 // retry up to 3 times on failure
  backoff: { type: 'exponential', delay: '30s' }, // growing wait time between attempts
  async handle({ userId }) {
    // the actual work — runs on the worker
    console.log(`Sending welcome email to user ${userId}`)
  },
})
```

**2. Register the plugin in the application** (e.g. `src/app.ts`):

```ts
import { createApp } from '@basaltkit/core'
import { queuePlugin } from '@basaltkit/queue'
import { SendWelcomeEmail } from './jobs/send-welcome-email.js'

const app = await createApp({
  plugins: [
    queuePlugin({
      jobs: [SendWelcomeEmail],
      // no `connection` → sync driver: runs immediately, no Redis needed (ideal for dev)
    }),
  ],
}).boot()
```

**3. Dispatch the job wherever you need it:**

```ts
await SendWelcomeEmail.dispatch({ userId: 'u-123' })
```

Done. In dev, `handle` runs immediately. When you want real production behavior, swap `queuePlugin` for your backend's plugin and declare the workers:

```ts
import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'

bullmqQueuePlugin({
  jobs: [SendWelcomeEmail],
  connection: 'redis://localhost:6379',
  workers: [{ queue: 'default', concurrency: 5 }], // this process processes the queue
})
```

Only that import changes between backends — the job code never does.

## Usage guide

### Defining a job with `defineJob`

```ts
import { defineJob } from '@basaltkit/queue'
import { z } from 'zod'

export const GenerateInvoice = defineJob({
  name: 'billing.invoice',
  schema: z.object({ orderId: z.string() }),
  queue: 'billing',      // dedicated queue (default: 'default')
  attempts: 5,
  backoff: { type: 'fixed', delay: '1m' },
  async handle({ orderId }) {
    // generate the invoice…
  },
})
```

`schema` is optional but recommended: it validates the data **twice** — on `dispatch` (before entering the queue) and on the worker (before running). An invalid payload throws `JobValidationError` right at `dispatch`, without polluting the queue.

### Dispatching with delay or priority

```ts
import { GenerateInvoice } from './jobs/generate-invoice.js'

// runs 10 minutes from now
await GenerateInvoice.dispatch({ orderId: 'o-1' }, { delay: '10m' })

// priority (lower number = higher priority, BullMQ semantics)
await GenerateInvoice.dispatch({ orderId: 'o-2' }, { priority: 1 })
```

Note: with the sync driver, `delay` and `priority` are ignored — the job runs immediately.
That is not silent: the sync driver declares `delayed: false` / `priority: false`, so the
`onUnsupported` policy fires (by default a one-off `console.warn` per job+feature). Set
`onUnsupported: 'throw'` in production if a delay is load-bearing.

### Context propagation (tenant, requestId…)

If you dispatch a job inside a request with active context (`runWithContext` from `@basaltkit/core`, usually done by HTTP middleware), the fields `requestId`, `correlationId`, `traceId`, `userId`, `tenantId` — and `tenant.id` / `user.id` — are captured and restored inside `handle`:

```ts
import { ctx, runWithContext } from '@basaltkit/core'
import { defineJob, QueueManager, SyncQueueDriver } from '@basaltkit/queue'

const job = defineJob({
  name: 'ctx.probe',
  handle: () => {
    // inside the worker, the original context is available
    console.log(ctx().requestId, ctx()['tenant'])
  },
})

const manager = new QueueManager(new SyncQueueDriver())
manager.register(job)

await runWithContext({ requestId: 'req-7', tenant: { id: 'acme', name: 'Acme' } }, () =>
  job.dispatch({}),
)
// inside handle: requestId = 'req-7', tenant = { id: 'acme' }  (only the id is serialized)
```

### Turning an event listener into a job: `queuedOn`

If you use `@basaltkit/events`, `queuedOn` bridges events→queue: `emit` just puts the job on the queue, and the handler runs on the worker with retries and restored context.

```ts
import { EventBus, defineEvent } from '@basaltkit/events'
import { QueueManager, SyncQueueDriver, queuedOn } from '@basaltkit/queue'
import { z } from 'zod'

const bus = new EventBus()
const manager = new QueueManager(new SyncQueueDriver())
const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

const unsubscribe = queuedOn(bus, manager, OrderCreated, async ({ orderId }) => {
  // runs on the worker, with the driver's retry/backoff
}, { queue: 'orders', attempts: 3 })

await bus.emit(OrderCreated, { orderId: 'o-1' })
// the created job is named 'listener:order.created'
```

`queuedOn` returns the function to cancel the subscription.

### Producer and worker in separate processes (production)

One process can only **produce** (call `dispatch`) and another only **consume** (run workers). Both must register the **same jobs** (the worker needs the `handle`):

```ts
// API process (produces only)
bullmqQueuePlugin({ jobs: [SendWelcomeEmail, GenerateInvoice], connection: process.env.REDIS_URL! })

// worker process (consumes)
bullmqQueuePlugin({
  jobs: [SendWelcomeEmail, GenerateInvoice],
  connection: process.env.REDIS_URL!,
  workers: [
    { queue: 'default', concurrency: 5 },
    { queue: 'billing', concurrency: 2 },
  ],
})
```

If a job reaches a worker that hasn't registered it, `UnknownJobError` is thrown.

### CLI commands (`basalt queue:*`)

Registering `queuePlugin` also wires four CLI commands (run via the `@basaltkit/cli` runner):

```bash
basalt queue:work --queue=default --concurrency=5   # run a worker until Ctrl+C
basalt queue:stats --queue=billing                  # waiting/active/completed/failed/delayed
basalt queue:retry --queue=billing --limit=100      # re-enqueue failed jobs
basalt queue:jobs  --queue=billing --states=failed  # list individual jobs
```

`queue:jobs` flags:

| Flag | Default | Description |
|---|---|---|
| `--queue` | `default` | Queue to inspect. |
| `--states` | `completed,failed,waiting,active` | Comma-separated states from `waiting`, `active`, `completed`, `failed`, `delayed`. An unknown state is rejected with the valid list, never silently dropped. |
| `--limit` | `20` | Maximum rows in **total** (newest first), capped at `1000`. |
| `--payload` | off | Also print each job's payload (truncated). **Off by default: payloads can contain personal data.** |

```
id    name           state      attempts  age
1042  email.welcome  completed  1         3s
1041  email.welcome  failed     3         2m
2 job(s) on "billing" (completed, failed, waiting, active, limit 20). Payloads hidden — add --payload to include them.
```

`queue:stats`, `queue:retry` and `queue:jobs` need a driver that can introspect job
state — the **BullMQ** driver (a Redis `connection`). With the inline `sync` driver,
or a broker driver that cannot read a job without consuming it (RabbitMQ, SQS, Kafka),
they report the operation as unsupported rather than guessing.

### Manual use without a plugin (e.g. in tests)

```ts
import { QueueManager, SyncQueueDriver, defineJob } from '@basaltkit/queue'

const driver = new SyncQueueDriver()
const manager = new QueueManager(driver)

const job = defineJob({ name: 'demo', handle: () => {} })
manager.register(job)

await job.dispatch({})
console.log(driver.executed) // [{ queue: 'default', jobName: 'demo', attempts: 1 }]
```

`SyncQueueDriver` keeps a history in `driver.executed` — very handy for test assertions.

## API reference

### `defineJob<T>(config): JobDefinition<T>`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `name` | `string` | Yes | — | Unique job name (e.g. `'email.welcome'`). |
| `schema` | `JobSchema<T>` (Zod-compatible) | No | — | Validates the payload on dispatch and on the worker. |
| `queue` | `string` | No | `'default'` | Name of the queue the job goes into. |
| `attempts` | `number` | No | `1` | Maximum number of attempts on failure. |
| `backoff` | `JobBackoff` | No | — | Wait strategy between attempts. |
| `removeOnComplete` | `JobRetention` | No | the `queuePlugin` default | Redis retention for this job once it completes — overrides the plugin-wide default. |
| `removeOnFail` | `JobRetention` | No | the `queuePlugin` default | Redis retention for this job once it fails permanently — overrides the plugin-wide default. |
| `handle` | `(payload: T) => void \| Promise<void>` | Yes | — | The function that does the work (runs on the worker). |

`JobRetention` = `boolean | number | { age?: DurationInput; count?: number }`. `true` removes
the job as soon as it finishes, `false` keeps it forever, a number keeps that many most-recent,
and `{ age, count }` caps by both. Only the BullMQ driver stores finished jobs, so only it
honours retention; the sync driver stores nothing and ignores it.

The returned object (`JobDefinition<T>`) exposes:

- `dispatch(payload, options?)` — puts the job on the queue. Throws `JobNotRegisteredError` if the job hasn't yet been registered with a `QueueManager`.
- `name`, `schema`, `queue`, `attempts`, `backoff`, `handle` — the configured values.
- `__bind(dispatcher)` — **Advanced/internal**: used by `QueueManager` on registration.

### `DispatchOptions`

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `delay` | `DurationInput` (e.g. `'30s'`, `'10m'`, or ms) | No | no delay | Delays execution (BullMQ driver only). |
| `priority` | `number` | No | — | BullMQ priority (lower = higher priority). |

### `JobBackoff`

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `type` | `'exponential' \| 'fixed'` | Yes | — | Growing or constant wait between attempts. |
| `delay` | `DurationInput` | Yes | — | Base wait (e.g. `'30s'`). |

### `queuePlugin(options?: QueuePluginOptions)`

Basalt plugin that registers a `QueueManager` in the container under the `QUEUE` token, starts workers on `boot`, and closes everything on `shutdown`.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `jobs` | `JobDefinition[]` | No | `[]` | Jobs known to this process (producer and/or worker). |
| `driver` | `QueueDriver` | No | sync driver | The backend. Omit it and jobs run inline on the sync driver (right for dev/tests, wrong for production). You rarely set this by hand — your backend's plugin (`bullmqQueuePlugin` and friends) does it for you. |
| `workers` | `{ queue: string; concurrency?: number }[]` | No | `[]` | Queues whose workers start in this process on boot. |
| `onUnsupported` | `'throw' \| 'warn' \| 'ignore'` | No | `'warn'` | What happens when a dispatch uses an option the active driver cannot honour (a delay on Kafka, a priority on SQS). `'warn'` logs once per job+feature and proceeds; `'throw'` raises `UnsupportedJobOptionError` — set it in production when the option is load-bearing; `'ignore'` is silent. |
| `removeOnComplete` | `JobRetention` | No | driver default (BullMQ keeps the last `1000`) | Default retention for completed jobs, on backends that keep them. A job's own `removeOnComplete` wins. |
| `removeOnFail` | `JobRetention` | No | driver default (BullMQ `false` — keep all) | Default retention for failed jobs. Keeping all is deliberate (inspection and `queue:retry`); set e.g. `{ age: '14d' }` so failures don't grow unbounded. |

**Connection options live on your backend's plugin, not here.** Each driver package exports a
plugin that takes these same keys *plus* its own connection settings and failure hooks —
`bullmqQueuePlugin({ connection, onError, onJobFailed, jobs, workers })`. That keeps this core
free of any one backend's vocabulary. See [Failure hooks](#failure-hooks) below.

```ts
import { QUEUE } from '@basaltkit/queue'
const manager = app.container.get(QUEUE) // get the QueueManager from the container
```

### `class QueueManager` — implements `JobDispatcher`

| Method | Signature | Description |
|---|---|---|
| `constructor` | `new QueueManager(driver: QueueDriver, options?: QueueManagerOptions)` | Creates the manager over a driver. |
| `register` | `(job) => this` | Registers a job and wires its `dispatch`. |
| `dispatch` | `<T>(job, payload: T, options?: DispatchOptions) => Promise<void>` | Validates, snapshots the request context, checks the driver's capabilities, and enqueues. Auto-registers the job if not registered yet. |
| `work` | `(queue = 'default', { concurrency? }?) => void` | Starts a worker for the queue (no-op on the sync driver). |
| `stats` | `(queue = 'default') => Promise<QueueStats \| undefined>` | Job counts per state, or `undefined` when the driver can't introspect (sync). |
| `retryFailed` | `(queue = 'default', { limit? }?) => Promise<number \| undefined>` | Re-enqueues failed jobs; returns the count, or `undefined` when the driver doesn't support it. |
| `list` | `(queue = 'default', options?: ListJobsOptions) => Promise<JobSummary[] \| undefined>` | Lists individual jobs, newest first, payload already unwrapped from the dispatch envelope. `undefined` when the driver can't list. |
| `close` | `() => Promise<void>` | Closes workers and connections. |

`QueueManagerOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `onUnsupported` | `'throw' \| 'warn' \| 'ignore'` | `'warn'` | Same policy as the plugin option. |
| `warn` | `(message: string) => void` | `console.warn` | Where `'warn'` diagnostics go — point it at your logger. |
| `removeOnComplete` | `JobRetention` | driver default | Default retention for completed jobs. |
| `removeOnFail` | `JobRetention` | driver default | Default retention for failed jobs. |

### Listing jobs — `manager.list(queue?, options?)`

The supported way to see *which* jobs are on a queue, without reaching into the
broker's own client (which re-couples your app to one backend):

```ts
import { QUEUE } from '@basaltkit/queue'

const jobs = await app.container.get(QUEUE).list('billing', { states: ['failed'], limit: 10 })
if (!jobs) {
  // the active driver cannot list — handle it, don't assume an empty queue
} else {
  for (const job of jobs) console.log(job.id, job.name, job.state, job.payload)
}
```

`ListJobsOptions`:

| Field | Type | Default | Description |
|---|---|---|---|
| `states` | `JobState[]` | `['completed', 'failed', 'waiting', 'active']` | Which states to look in. `JobState` = `'waiting' \| 'active' \| 'completed' \| 'failed' \| 'delayed'` — the same vocabulary as `QueueStats`. |
| `limit` | `number` | `20` (max `1000`) | Maximum jobs returned in **total**, newest first — not per state. Each state is read up to `limit` and the merged result is truncated, so one busy state can't starve the others. |

**Why `completed` and `failed` are in the default.** A worker drains `waiting` in
milliseconds, so a healthy queue shows `waiting: 0, active: 0` almost always.
Defaulting to only those would answer "did my job run?" with an empty list on a
queue that is working perfectly. `delayed` is *not* in the default — it is a
separate question; ask for it explicitly.

`JobSummary` (driver-neutral — never the backend's own job object):

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Backend-assigned job id. |
| `name` | `string` | The job name from `defineJob({ name })`. |
| `state` | `JobState` | Where the job was found. |
| `attemptsMade` | `number` | Attempts so far (`0` before the first run). |
| `timestamp` | `number` | Creation time, epoch ms. |
| `payload` | `unknown` | **Your** payload — already unwrapped from the `{ payload, context }` dispatch envelope. |
| `context` | `RequestContext \| undefined` | The request context captured at dispatch (`requestId`, `tenantId`, …), when there was one. |
| `failedReason` | `string \| undefined` | Why it failed — only for `state: 'failed'`. |

**A `JobSummary` carries the job's payload, so it can carry personal data.** Treat
the result like the records it came from: never log it wholesale, and if you expose
it over HTTP, require authentication (`meta: { auth: true }`), authorize it per
tenant, and put raw payloads behind an explicit opt-in. `basalt queue:jobs` follows
the same rule — it hides payloads unless you pass `--payload`.

`readJobEnvelope(data)` is exported for custom drivers implementing `list`: it
opens the `{ payload, context }` envelope defensively, treating anything that
isn't one (an older producer, a hand-written job) as the payload itself.
`DEFAULT_LIST_STATES`, `DEFAULT_LIST_LIMIT` and `MAX_LIST_LIMIT` are exported so
a custom driver defaults the same way BullMQ does.

### `queuedOn<T>(bus, manager, event, handler, options?): () => void`

Creates the event→job bridge. Returns the subscription cancel function.

`QueuedListenerOptions`:

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `queue` | `string` | No | `'default'` | Queue for the created job. |
| `attempts` | `number` | No | `1` | Job attempts. |
| `backoff` | `JobBackoff` | No | — | Job backoff. |

### Drivers

- **`class SyncQueueDriver`** — runs inline on `dispatch`, honors `attempts` (immediate retry). Public property `executed: { queue, jobName, attempts }[]` with the execution history (capped at 1000 entries). For testing and dev without Redis.
- **`class BullmqQueueDriver`** — production over Redis; see the options table below. Lives in its own package, [`@basaltkit/queue-bullmq`](https://www.npmjs.com/package/@basaltkit/queue-bullmq), alongside `bullmqQueuePlugin`, exactly like the RabbitMQ/SQS/Kafka driver packages.
- **`interface QueueDriver`** (Advanced) — contract for custom drivers: `setExecutor(executor)`, `add(queue, jobName, data, options: AddJobOptions)`, `startWorker(queue, { concurrency? })`, optional `stats(queue)` / `retryFailed(queue, { limit? })` / `list(queue, options)`, `close()`, plus the optional `name` and `capabilities` fields. Helper types: `AddJobOptions`, `JobExecutor`, `QueueStats`, `DriverCapabilities`, `JobState`, `JobSummary`, `JobEnvelope`, `ListJobsOptions`.

  The three optional methods are a deliberate pattern: a driver **omits** what its
  backend cannot do, `QueueManager` returns `undefined`, and the caller gets an
  honest "unsupported" instead of a guess. Omit `list` rather than implement it
  with a destructive read — merely *looking* at a queue must never change it.

  | Driver | `stats` | `retryFailed` | `list` | Why |
  |---|:---:|:---:|:---:|---|
  | `bullmq` | ✅ | ✅ | ✅ | Redis keeps jobs; reading them is non-destructive. |
  | `sync` | ❌ | ❌ | ❌ | Runs inline and stores nothing. |
  | [`rabbitmq`](https://www.npmjs.com/package/@basaltkit/queue-rabbitmq) | ❌ | ❌ | ❌ | AMQP has no non-destructive read: `basic.get`/consume hide the message from real workers and mark it redelivered. |
  | [`sqs`](https://www.npmjs.com/package/@basaltkit/queue-sqs) | ❌ | ❌ | ❌ | `ReceiveMessage` starts the visibility timeout and bumps `ApproximateReceiveCount` — peeking could redrive jobs to the DLQ. |
  | [`kafka`](https://www.npmjs.com/package/@basaltkit/queue-kafka) | ❌ | ❌ | ❌ | Reading is non-destructive, but a log has no per-message state — any job states would be invented. |

#### `new BullmqQueueDriver(options: BullmqDriverOptions)`

```ts
import { BullmqQueueDriver } from '@basaltkit/queue-bullmq'
```

(The `BullmqDriverOptions` **type** is also re-exported from `@basaltkit/queue` — types are erased at build, so they cost nothing.)

| Option | Type | Default | Purpose |
|---|---|---|---|
| `connection` | `string \| ConnectionOptions` | — (required) | Redis URL (`redis://…`, `rediss://…` → TLS) or ioredis options. |
| `onError` | `(error: unknown, info: { queue: string; source: 'worker' \| 'queue' }) => void` | `console.error` with the queue name and source | Infra errors from BullMQ's `Worker`/`Queue` EventEmitters (Redis down, connection reset). Node makes an unlistened `'error'` event **fatal**, so the driver always attaches a listener — override this to route the fault into your logger/alerting. |
| `onJobFailed` | `(info: { queue: string; job: string; jobId?: string; error: unknown }) => void` | `console.error` naming the job, its id and the queue | A job **exhausted its retries** (BullMQ's `'failed'` event). Without it, permanently-failed jobs are only visible by polling `queue:stats`. |

Retention defaults applied by this driver when neither the job nor the plugin sets one:
completed → keep the last `1000`; failed → keep all.

#### `DriverCapabilities`

Each driver declares what its backend honours — `{ delayed, priority, retries, backoff }`, all
`boolean`. `QueueManager.dispatch` compares a dispatch's options against them and applies
`onUnsupported`. A driver that omits `capabilities` is treated as fully capable.

| Driver | `delayed` | `priority` | `retries` | `backoff` |
|---|:---:|:---:|:---:|:---:|
| `bullmq` | ✅ | ✅ | ✅ | ✅ |
| `sync` | ❌ | ❌ | ✅ | ❌ |
| [`rabbitmq`](https://www.npmjs.com/package/@basaltkit/queue-rabbitmq) | ✅ | ✅ | ✅ | ✅ |
| [`sqs`](https://www.npmjs.com/package/@basaltkit/queue-sqs) | ✅ (≤ 15 min) | ❌ | ✅ | ✅ |
| [`kafka`](https://www.npmjs.com/package/@basaltkit/queue-kafka) | ❌ | ❌ | ✅ | ❌ |

### Failure hooks

The queue has no hook bus of its own — failures are reported through driver callbacks, and every
one of them has a **non-silent default**, so nothing disappears if you configure nothing.

| Hook | Where it lives | Receives | Default when unset |
|---|---|---|---|
| `onError` | `QueuePluginOptions` or `BullmqDriverOptions` | `(error, { queue, source: 'worker' \| 'queue' })` | `console.error` with queue + source |
| `onJobFailed` | `QueuePluginOptions` or `BullmqDriverOptions` | `({ queue, job, jobId?, error })` | `console.error` naming the job |
| `warn` | `QueueManagerOptions` | `(message: string)` | `console.warn`, once per job+feature |
| `onError` | [`RabbitmqDriverOptions`](https://www.npmjs.com/package/@basaltkit/queue-rabbitmq) | `(error, { source: 'connection' \| 'channel' })` | `console.error` |
| `onError` | [`KafkaDriverOptions`](https://www.npmjs.com/package/@basaltkit/queue-kafka) | `(error, { source: 'consumer' \| 'producer'; queue? })` | `console.error` |
| `onError` | [`SqsDriverOptions`](https://www.npmjs.com/package/@basaltkit/queue-sqs) | `(error, { queue })` | `console.error`, then an `errorPauseMs` pause |

Only the BullMQ driver has `onJobFailed`; the broker drivers route an exhausted job to their own
dead-letter destination (`q.dead`, `<topic>.dead`, `<queue>-dead`) instead.

Set the BullMQ callbacks right on its plugin, beside `jobs` and `workers`:

```ts
import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'

bullmqQueuePlugin({
  connection: process.env.REDIS_URL!,
  jobs: [SendWelcomeEmail],
  workers: [{ queue: 'default', concurrency: 5 }],
  onError: (error, { queue, source }) => logger.error({ err: error, queue, source }, 'queue infra error'),
  onJobFailed: ({ queue, job, jobId, error }) =>
    logger.error({ err: error, queue, job, jobId }, 'job failed permanently'),
})
```

Building the driver yourself works too — it then owns its callbacks, so set them in its
constructor:

```ts
import { queuePlugin } from '@basaltkit/queue'
import { BullmqQueueDriver } from '@basaltkit/queue-bullmq'

queuePlugin({
  jobs: [SendWelcomeEmail],
  driver: new BullmqQueueDriver({
    connection: process.env.REDIS_URL!,
    onError: (error, { queue, source }) => logger.error({ err: error, queue, source }, 'queue infra error'),
  }),
})
```

### Exported errors

| Error | Code | When |
|---|---|---|
| `JobValidationError` | `JOB_INVALID` | The payload failed the job's `schema` — on `dispatch` and again on the worker. Carries `.job` and `.issues`. |
| `JobNotRegisteredError` | `QUEUE_JOB_NOT_REGISTERED` | `job.dispatch()` was called before the job was registered in a `QueueManager`. |
| `UnknownJobError` | `QUEUE_UNKNOWN_JOB` | A job reached the worker but is not registered in that process — producer and worker registered different job lists. |
| `UnsupportedJobOptionError` | `QUEUE_UNSUPPORTED_OPTION` | With `onUnsupported: 'throw'`, a dispatch used an option the active driver's `capabilities` do not include. `status = 500`. |

Errors thrown outside these classes come from the driver's client (ioredis, amqplib, kafkajs,
the AWS SDK) and reach you through that driver's `onError`.

### Token

- `QUEUE: Token<QueueManager>` — injection token to get the manager from the container.

## Common issues and solutions (FAQ)

**"Job X has not been registered in a QueueManager yet" on `dispatch`.**
The job wasn't passed in `queuePlugin({ jobs: [...] })` nor registered with `manager.register(job)`. Add it to the plugin's job list.

**"Job X reached the worker but is not registered in this process".**
The worker process doesn't know that job. Producer and worker must register the **same** list of jobs.

**The job never runs in production.**
Check whether any process started workers for the right queue: `queuePlugin({ workers: [{ queue: 'default' }] })` or `manager.work('default')`. Also check that the job's `queue` matches the worker's.

**`JobValidationError: Invalid payload…`**
The data passed to `dispatch` doesn't match the `schema`. The error includes `issues` with Zod's details. This is intentional — it protects the queue from corrupted data.

**In dev, `delay` doesn't work.**
The sync driver always runs immediately. Delays, timed backoff, and priority only have a real effect with the BullMQ driver (with `connection`).

**`[basalt/queue] The "sync" driver does not support …` in the logs.**
The `onUnsupported` policy caught a dispatch option the active driver can't honour. It warns once per job+feature. Either switch to a driver that supports it, drop the option, or set `onUnsupported: 'ignore'` if you accept the degradation.

**A job failed for good and nothing was logged.**
Only the BullMQ driver reports exhausted jobs, via `onJobFailed` (default `console.error`). If you replaced it with a no-op, you removed the only signal. On the broker drivers, inspect the dead-letter destination (`q.dead`, `<topic>.dead`, `<queue>-dead`).

**How do I see what's actually on the queue?**
`basalt queue:stats` for the counts and `basalt queue:jobs` for the individual jobs
(or `QUEUE`'s `manager.stats()` / `manager.list()` in code). Don't open the broker's
own client — that couples your app to one backend and hands you the raw dispatch
envelope instead of your payload. On a driver that can't introspect, both return
`undefined` / print "Not supported" — an honest gap, not an empty queue.

**Do I need Redis to run the tests?**
No. Without `connection`, the plugin uses `SyncQueueDriver`. You can also instantiate the driver directly and inspect `driver.executed`.

## Sync driver semantics

The inline sync driver (the default without a `connection`) is at-most-once:
handler errors reject `dispatch()` and an exhausted job is lost. Selecting it
implicitly in production logs a boot warning — pass `driver: new
SyncQueueDriver()` to opt in deliberately. Its `executed[]` history is capped
at 1000 entries.

## How it connects to other modules

- **`@basaltkit/core`** — provides `createApp`/`definePlugin` (`queuePlugin` is a core plugin), the ALS context (`runWithContext`/`ctx`) propagated to workers, `parseDuration` (formats `'30s'`, `'10m'`), and the base `BasaltError` class.
- **`@basaltkit/events`** — via `queuedOn`, any domain event can be processed in the background with retries.
- **`@basaltkit/scheduler`** — `schedule.job(MyJob, payload)` schedules a `dispatch` for a job from this queue on cron schedules (e.g. daily reconciliation at 03:00).
- **`@basaltkit/logger`** — since context is restored on the worker, logs written inside `handle` automatically carry `requestId`/`tenantId` from the original request.
- **`@basaltkit/audit`** and **`@basaltkit/activity`** — records made inside a `handle` inherit the same context (actor, tenant), keeping the trail consistent between the request and the worker.
