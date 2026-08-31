<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/queue-rabbitmq

**RabbitMQ** driver for [`@basaltkit/queue`](https://www.npmjs.com/package/@basaltkit/queue): runs your jobs over AMQP instead of Redis/BullMQ, without changing a single line of your job code. You need this package when your messaging infrastructure is already RabbitMQ (or when you want a dedicated message broker, with native routing and dead-lettering).

## What this module solves

`@basaltkit/queue` defines **jobs** (background tasks) abstractly and picks the backend via a *driver*. By default it uses BullMQ (Redis). This package provides an alternative driver that talks to **RabbitMQ**: jobs are published to durable AMQP queues, workers consume them, and retries/delays use a *delay queue* with TTL-based dead-lettering.

Everything else — `defineJob`, `dispatch`, workers, context propagation — stays exactly the same. You just swap the driver.

## Installation

```bash
pnpm add @basaltkit/queue-rabbitmq amqplib
```

`amqplib` is a **peer dependency** (you install it yourself): that way, anyone using a different driver doesn't pull in the RabbitMQ client. You'll also need an accessible RabbitMQ server.

## Get started in 5 minutes

Define jobs as always (with `@basaltkit/queue`) and register this package's plugin:

```ts
import { createApp } from '@basaltkit/core'
import { defineJob } from '@basaltkit/queue'
import { rabbitmqQueuePlugin } from '@basaltkit/queue-rabbitmq'

const SendWelcome = defineJob<{ email: string }>({
  name: 'send-welcome',
  queue: 'emails',
  attempts: 3,
  backoff: { type: 'exponential', delay: '10s' },
  async handle({ email }) {
    // ... send the email
  },
})

const app = await createApp({
  plugins: [
    rabbitmqQueuePlugin({
      url: process.env.AMQP_URL!,
      jobs: [SendWelcome],
      workers: [{ queue: 'emails', concurrency: 10 }],
      onUnsupported: 'throw', // optional: fail if a job requests something the driver can't do
    }),
  ],
}).boot()

await SendWelcome.dispatch({ email: 'ada@acme.test' })
```

## How it works

For each queue `q`, the driver declares three durable AMQP queues:

- **`q`** — the main queue (with `x-max-priority`, to support priority).
- **`q.delay`** — the delay/retry buffer: messages expire after their TTL and get *dead-lettered* back to `q`. This is how `delay` and `backoff` between attempts are implemented.
- **`q.dead`** — the *dead-letter queue*: where jobs that exhausted their attempts end up.

The attempt number travels in the message headers (`x-basalt-attempt`), so the worker knows whether it should retry (via `q.delay`) or give up (via `q.dead`).

### Capabilities

| Capability | Supported | How |
|---|:---:|---|
| `delayed` (delayed delivery) | ✅ | `q.delay` with a per-message TTL |
| `priority` | ✅ | `x-max-priority` on the queue |
| `retries` | ✅ | re-publishing with an attempt counter |
| `backoff` | ✅ | TTL on `q.delay` (fixed or exponential) |

The driver declares these `capabilities`, so, combined with `onUnsupported`, a job that requests something unsupported **fails loudly** instead of being silently ignored.

### Inspection: no `list()` / `queue:jobs`

This driver deliberately does **not** implement the queue's optional
`list(queue, options)` capability, so `basalt queue:jobs` reports it as
unsupported instead of returning something misleading.

AMQP has no non-destructive read. `basic.get` and a consumer both *deliver* the
message to the caller, making it invisible to real workers until it is acked or
nacked; nacking it back marks it `redelivered`, and the management API's
`POST /api/queues/.../get` is documented as "not meant to be used as a normal
way of consuming". Implementing `list()` on top of that would mean **inspecting
a queue changes it** — a debugging command that can perturb production work is
worse than no command. The gap is honest; use RabbitMQ's own management UI to
browse, and `q.dead` to inspect exhausted jobs.

## API reference

### `new RabbitmqQueueDriver(options)`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `url` | `string` | — (required) | AMQP URL, e.g. `amqp://user:pass@host:5672`. |
| `maxPriority` | `number` | `10` | Maximum priority level declared as `x-max-priority` on the main queue. Raise it only if you actually use more levels — RabbitMQ allocates a sub-queue per level. |
| `drainTimeoutMs` | `number` | `10_000` | How long `close()` waits for in-flight handlers to finish so their acks land on a live channel. Anything unfinished stays **unacked** and the broker redelivers it. Raise it if your handlers are long-running. |
| `onError` | `(error: unknown, info: { source: 'connection' \| 'channel' }) => void` | `console.error` with the source | The single fault channel for this driver — see below. |
| `connect` | `(url: string) => Promise<AmqpConnection>` | `amqplib` | Injectable connector; tests pass a fake so no broker is needed. |

Implements the `QueueDriver` contract from `@basaltkit/queue` (`add`, `startWorker`, `setExecutor`, `close`, `capabilities`). It does **not** implement the optional `stats` / `retryFailed`, so `basalt queue:stats` and `basalt queue:retry` report the operation as unsupported.

### Failure hooks

`onError` is the only callback, and its default (`console.error`) is deliberately never silent —
amqplib surfaces broker faults as EventEmitter `'error'` events, and an unlistened one is
**fatal** in Node.

| `source` | Raised when |
|---|---|
| `'connection'` | The amqplib connection emitted `'error'`, **or** a worker failed to connect/assert/consume at boot. Without this the app would report healthy with zero workers and the rejection would kill the process. |
| `'channel'` | The channel emitted `'error'`, **or** a retry/dead-letter re-publish went unconfirmed / the `ack` itself threw. Nothing was acked in that case, so the broker still owns the job and redelivers it. |

There is no `onJobFailed` here: a job that exhausts `attempts` is routed to `q.dead`, which *is*
the report. Watch that queue's depth.

### Exported errors

This driver throws no error classes of its own — every fault reaches you through `onError`, and
option-compatibility errors (`UnsupportedJobOptionError`, `QUEUE_UNSUPPORTED_OPTION`) come from
`@basaltkit/queue` before the driver is ever called.

### Hard limits

Attempt and backoff values travel in message headers, which a broker client other than yours
could forge, so the consumer clamps what it reads: at most **50** attempts and a backoff TTL of
at most **24 h** (the exponent is capped at 16). A crafted message cannot turn the retry loop
into an amplification attack.

## Important caveat

`q.delay` uses a **per-message TTL**, and RabbitMQ only releases a message once it reaches the *head* of the queue (head-of-line blocking). For widely varying delays at large scale, a message with a long TTL can block the ones behind it. If you need mixed delays at high throughput, consider the [RabbitMQ Delayed Message Exchange plugin](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) — the driver's model stays the same, only the delay mechanism changes.

## Delivery guarantees: publisher confirms before ack

This is the property that makes the driver safe to lose a broker under, so it is worth being
precise about the ordering.

On connect the driver asks for a **publisher-confirm channel** (`createConfirmChannel`) and
falls back to a plain channel only if the client doesn't offer one. On a confirm channel,
`sendToQueue` returning does **not** mean the broker has the message — `waitForConfirms()`
resolving does.

- **Dispatching.** `add()` publishes and then awaits `waitForConfirms()`. `dispatch()` therefore
  resolves only once the broker has taken responsibility for the job — a caller that got a
  resolved promise can trust the job exists.
- **Failing a job.** When a handler throws, the consumer re-publishes the message (to `q.delay`
  for another attempt, or to `q.dead` when `attempts` is exhausted), awaits
  `waitForConfirms()`, and **only then** acks the original. Acking first would open a window
  where the original is gone and the copy never arrived — the job silently vanishes.
- **When the confirm never comes.** If `waitForConfirms()` rejects, or the `ack` itself throws,
  the driver reports through `onError({ source: 'channel' })` and returns. Nothing was acked, so
  the durable original is still on the broker and gets redelivered. The cost of a broker blip is
  a duplicate delivery, never a lost job — **make your handlers idempotent**.
- **Shutting down.** `close()` stops accepting new messages, drains in-flight handlers for up to
  `drainTimeoutMs` (default 10 s) so their acks land on a live channel, then tears the channel
  and connection down. Whatever didn't finish stays unacked and is redelivered.

On a plain (non-confirm) channel `waitForConfirms` is absent and simply skipped: publishes are
fire-and-forget and the ack-before-confirm window reopens. Use a client that supports
`createConfirmChannel` — amqplib does.

### The plugin, and the driver underneath it

`rabbitmqQueuePlugin` is the one-line path: it builds the driver and hands it to
`queuePlugin` from `@basaltkit/queue`, so it accepts every core option
(`jobs`, `workers`, `onUnsupported`, `removeOnComplete`, `removeOnFail`)
alongside the driver options documented above. Every backend ships a plugin of
this shape, so no backend is privileged in the core's API.

`RabbitmqQueueDriver` stays exported for the rarer cases — sharing one driver
between plugins, wrapping it, or testing it directly:

```ts
import { queuePlugin } from '@basaltkit/queue'
import { RabbitmqQueueDriver } from '@basaltkit/queue-rabbitmq'

queuePlugin({ driver: new RabbitmqQueueDriver({ /* … */ }), jobs, workers })
```

## How it connects to other modules

- **`@basaltkit/queue`** — this is a driver for that package; the entire job API comes from there.
- See also the sibling drivers: [`@basaltkit/queue-kafka`](https://www.npmjs.com/package/@basaltkit/queue-kafka) and [`@basaltkit/queue-sqs`](https://www.npmjs.com/package/@basaltkit/queue-sqs), and the [Queues & Jobs](https://github.com/basaltkit/basalt) guide for writing your own driver.
