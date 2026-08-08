# @machize/queue-rabbitmq

**RabbitMQ** driver for [`@machize/queue`](https://www.npmjs.com/package/@machize/queue): runs your jobs over AMQP instead of Redis/BullMQ, without changing a single line of your job code. You need this package when your messaging infrastructure is already RabbitMQ (or when you want a dedicated message broker, with native routing and dead-lettering).

## What this module solves

`@machize/queue` defines **jobs** (background tasks) abstractly and picks the backend via a *driver*. By default it uses BullMQ (Redis). This package provides an alternative driver that talks to **RabbitMQ**: jobs are published to durable AMQP queues, workers consume them, and retries/delays use a *delay queue* with TTL-based dead-lettering.

Everything else — `defineJob`, `dispatch`, workers, context propagation — stays exactly the same. You just swap the driver.

## Installation

```bash
pnpm add @machize/queue-rabbitmq amqplib
```

`amqplib` is a **peer dependency** (you install it yourself): that way, anyone using a different driver doesn't pull in the RabbitMQ client. You'll also need an accessible RabbitMQ server.

## Get started in 5 minutes

Define jobs as always (with `@machize/queue`) and pass the driver to `queuePlugin`:

```ts
import { createApp } from '@machize/core'
import { queuePlugin, defineJob } from '@machize/queue'
import { RabbitmqQueueDriver } from '@machize/queue-rabbitmq'

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
    queuePlugin({
      driver: new RabbitmqQueueDriver({ url: process.env.AMQP_URL! }),
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

The attempt number travels in the message headers (`x-machize-attempt`), so the worker knows whether it should retry (via `q.delay`) or give up (via `q.dead`).

### Capabilities

| Capability | Supported | How |
|---|:---:|---|
| `delayed` (delayed delivery) | ✅ | `q.delay` with a per-message TTL |
| `priority` | ✅ | `x-max-priority` on the queue |
| `retries` | ✅ | re-publishing with an attempt counter |
| `backoff` | ✅ | TTL on `q.delay` (fixed or exponential) |

The driver declares these `capabilities`, so, combined with `onUnsupported`, a job that requests something unsupported **fails loudly** instead of being silently ignored.

## API reference

### `new RabbitmqQueueDriver(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | — (required) | AMQP URL, e.g. `amqp://user:pass@host:5672`. |
| `maxPriority` | `number` | `10` | Maximum priority level (`x-max-priority`). |
| `connect` | `(url) => Promise<AmqpConnection>` | amqplib | Injectable connector — used in tests so no broker is needed. |

Implements the `QueueDriver` contract from `@machize/queue` (`add`, `startWorker`, `setExecutor`, `close`, `capabilities`).

## Important caveat

`q.delay` uses a **per-message TTL**, and RabbitMQ only releases a message once it reaches the *head* of the queue (head-of-line blocking). For widely varying delays at large scale, a message with a long TTL can block the ones behind it. If you need mixed delays at high throughput, consider the [RabbitMQ Delayed Message Exchange plugin](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) — the driver's model stays the same, only the delay mechanism changes.

## How it connects to other modules

- **`@machize/queue`** — this is a driver for that package; the entire job API comes from there.
- See also the sibling drivers: [`@machize/queue-kafka`](https://www.npmjs.com/package/@machize/queue-kafka) and [`@machize/queue-sqs`](https://www.npmjs.com/package/@machize/queue-sqs), and the [Queues & Jobs](https://github.com/Zebedeu/machize) guide for writing your own driver.
