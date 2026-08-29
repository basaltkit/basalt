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
3. **Two interchangeable drivers** — in production, use **BullMQ** (over Redis, with real retries and delays); in development and tests, use the **sync** driver, which runs the job immediately, in the same process, without needing Redis installed.

## Installation

```bash
pnpm add @basaltkit/queue
```

The package depends on `@basaltkit/core` and `@basaltkit/events` (installed automatically). For production you also need an accessible **Redis** server (BullMQ stores the queues there). For development and tests you need nothing.

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

Done. In dev, `handle` runs immediately. When you want real production behavior, add the Redis connection and the workers:

```ts
queuePlugin({
  jobs: [SendWelcomeEmail],
  connection: 'redis://localhost:6379',        // activates the BullMQ driver
  workers: [{ queue: 'default', concurrency: 5 }], // this process processes the queue
})
```

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

Note: with the sync driver, `delay` is ignored — the job runs immediately.

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
queuePlugin({ jobs: [SendWelcomeEmail, GenerateInvoice], connection: process.env.REDIS_URL! })

// worker process (consumes)
queuePlugin({
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

Registering `queuePlugin` also wires three CLI commands (run via the `@basaltkit/cli` runner):

```bash
basalt queue:work --queue=default --concurrency=5   # run a worker until Ctrl+C
basalt queue:stats --queue=billing                  # waiting/active/completed/failed/delayed
basalt queue:retry --queue=billing --limit=100      # re-enqueue failed jobs
```

`queue:stats` and `queue:retry` need a driver that can introspect job state — the
**BullMQ** driver (a Redis `connection`). With the inline `sync` driver they
report the operation as unsupported (it keeps no job state), rather than guessing.

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
| `handle` | `(payload: T) => void \| Promise<void>` | Yes | — | The function that does the work (runs on the worker). |

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
| `connection` | `string \| ConnectionOptions` | No | — | Redis URL (`redis://…` or `rediss://…`) or ioredis options. With a value → BullMQ driver; without one → sync driver. |
| `driver` | `QueueDriver` | No | — | Custom driver — takes precedence over `connection`. |
| `workers` | `{ queue: string; concurrency?: number }[]` | No | `[]` | Queues whose workers start in this process on boot. |

```ts
import { QUEUE } from '@basaltkit/queue'
const manager = app.container.get(QUEUE) // get the QueueManager from the container
```

### `class QueueManager` — implements `JobDispatcher`

| Method | Signature | Description |
|---|---|---|
| `constructor` | `new QueueManager(driver: QueueDriver)` | Creates the manager over a driver. |
| `register` | `(job) => this` | Registers a job and wires its `dispatch`. |
| `dispatch` | `<T>(job, payload: T, options?: DispatchOptions) => Promise<void>` | Validates and puts the job on the queue. Auto-registers the job if not registered yet. |
| `work` | `(queue = 'default', { concurrency? }?) => void` | Starts a worker for the queue (no-op on the sync driver). |
| `close` | `() => Promise<void>` | Closes workers and connections. |

### `queuedOn<T>(bus, manager, event, handler, options?): () => void`

Creates the event→job bridge. Returns the subscription cancel function.

`QueuedListenerOptions`:

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `queue` | `string` | No | `'default'` | Queue for the created job. |
| `attempts` | `number` | No | `1` | Job attempts. |
| `backoff` | `JobBackoff` | No | — | Job backoff. |

### Drivers

- **`class SyncQueueDriver`** — runs inline on `dispatch`, honors `attempts` (immediate retry). Public property `executed: { queue, jobName, attempts }[]` with the execution history. For testing and dev without Redis.
- **`class BullmqQueueDriver`** — production over Redis. `new BullmqQueueDriver({ connection })`, where `connection` is a Redis URL or ioredis options (`BullmqDriverOptions`). Completed jobs are cleaned up (keeps 1000); failed jobs are kept.
- **`interface QueueDriver`** (Advanced) — contract for custom drivers: `setExecutor(executor)`, `add(queue, jobName, data, options: AddJobOptions)`, `startWorker(queue, { concurrency? })`, `close()`. Helper types: `AddJobOptions`, `JobExecutor`.

### Exported errors

| Class | Code | When it occurs |
|---|---|---|
| `JobValidationError` | `JOB_INVALID` | Payload doesn't pass the `schema` (has `.job` and `.issues`). |
| `JobNotRegisteredError` | `QUEUE_JOB_NOT_REGISTERED` | `dispatch` before registering the job with a manager. |
| `UnknownJobError` | `QUEUE_UNKNOWN_JOB` | The job reached the worker but isn't registered in that process. |

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
