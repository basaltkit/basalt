<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/events

The Basalt event bus: domain events typed and validated with Zod, listeners with priority, wildcard patterns, and the *transactional outbox* pattern for reliable external delivery. You need this when you want parts of the application to react to things happening ("order created", "invoice paid") without knowing about each other.

## What this module solves

As an application grows, a simple "create order" ends up implying several things: sending an email, updating statistics, notifying another system. If the order code calls all of that directly, it becomes huge and fragile. The classic solution is **events**: the code announces "`order.created` happened" and whoever is interested subscribes and reacts — without coupling between the parts.

`@basaltkit/events` gives you an `EventBus` with three important guarantees. First, events are **typed and validated**: you define each event with `defineEvent`, optionally with a **schema** (a validatable description of the data shape, e.g. with the Zod library), and the payload is checked before any listener runs. Second, **listeners** (functions that react to the event) run in priority order and all of them run even if one fails — errors are aggregated at the end. Third, you can subscribe using **wildcard patterns**: `order.*` catches `order.created`, and `order.**` also catches `order.payment.failed`.

To communicate with **external** systems (webhooks, Kafka, …) the package includes the **Outbox**: instead of sending the event directly (and losing it if the application crashes midway), you first write the event to a durable store and a "mail carrier" delivers it afterward, retrying on failure. Delivery is *at-least-once*: nothing is lost between "written" and "delivered".

## Installation

```bash
pnpm add @basaltkit/events
```

`@basaltkit/core` comes as an automatic dependency. Zod is optional (only needed if you want to validate payloads): `pnpm add zod`.

## Get started in 5 minutes

1. Define a typed event.
2. Create the bus and subscribe to the event.
3. Emit the event with a validated payload.

```ts
import { defineEvent, EventBus } from '@basaltkit/events'
import { z } from 'zod'

// 1. Event with schema: the payload is validated on emit.
const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

// 2. Bus and subscription (the handler receives the typed payload).
const bus = new EventBus()
bus.on(OrderCreated, ({ orderId }) => {
  console.log(`New order: ${orderId}`)
})

// 3. Emit — TypeScript enforces the right payload.
await bus.emit(OrderCreated, { orderId: 'o-1' })
// An invalid payload (e.g. orderId: 123) throws EventValidationError
// BEFORE any listener runs.
```

In a full Basalt application, use the plugin instead of creating the bus by hand:

```ts
import { createApp } from '@basaltkit/core'
import { EVENTS, eventsPlugin } from '@basaltkit/events'

const app = await createApp({ plugins: [eventsPlugin()] }).boot()
const bus = app.container.get(EVENTS) // the same EventBus for the whole application
```

## Usage guide

### Events without a payload

If the event carries no data, omit the schema and the type — `emit` no longer accepts a second argument:

```ts
import { defineEvent, EventBus } from '@basaltkit/events'

const AppBooted = defineEvent('app.booted')

const bus = new EventBus()
bus.on(AppBooted, () => console.log('Booted!'))
await bus.emit(AppBooted)
```

You can also type without validating: `defineEvent<{ amount: number }>('invoice.paid')` — compile-time typing, no runtime check.

### Wildcards: listening to event families

Event names use dot-separated segments. In patterns, `*` matches **exactly one** segment and `**` matches **one or more**:

```ts
import { defineEvent, EventBus } from '@basaltkit/events'

const bus = new EventBus()

bus.on('order.*', (payload, meta) => {
  // catches order.created, order.cancelled — but NOT order.payment.failed
  console.log(`one segment: ${meta.name}`)
})
bus.on('order.**', (payload, meta) => {
  // catches order.created AND order.payment.failed
  console.log(`any suffix: ${meta.name}`)
})
bus.on('**', (payload, meta) => {
  // catches everything — useful for logging/auditing
  console.log(`global: ${meta.name}`)
})

await bus.emit(defineEvent('order.payment.failed'))
```

The handler's second argument, `meta`, carries the actual event name (`meta.name`) — essential for patterns.

### Priority, `once`, and cancelling subscriptions

```ts
import { defineEvent, EventBus } from '@basaltkit/events'

const AppBooted = defineEvent('app.booted')
const bus = new EventBus()

bus.on(AppBooted, () => console.log('first'), { priority: 10 }) // higher runs first
bus.on(AppBooted, () => console.log('last'), { priority: -1 })
bus.once(AppBooted, () => console.log('only once'))

const off = bus.on(AppBooted, () => console.log('never runs'))
off() // cancel the subscription

await bus.emit(AppBooted)
```

### Listener failures

A listener that throws an error **doesn't prevent** the others from running: all of them run, and at the end `emit` throws an `AggregateError` with every failure (in `error.errors`). This way, one broken listener never "hides" the others.

### Outbox: delivering events externally without losing them

Use `Outbox` directly when you want to control the timing of delivery:

```ts
import { MemoryOutboxStore, Outbox } from '@basaltkit/events'

const outbox = new Outbox(new MemoryOutboxStore(), { maxAttempts: 3 })

// 1. Write (with a database store: in the same transaction as the state change — see below):
await outbox.enqueue('invoice.paid', { id: 'in_1' }, 'tenant-acme')

// 2. Deliver pending entries (the "mail carrier"):
const result = await outbox.flush(async (entry) => {
  // send externally: webhook, Kafka, etc.
  console.log(`delivering ${entry.event}`, entry.payload)
})
console.log(result) // { published: 1, failed: 0 }
```

#### Writing the entry in your transaction

The pattern's guarantee — the event exists **if and only if** the state change committed — needs
the entry written *inside* the business transaction. Pass the transaction handle as `tx`; the
store writes through it, so a rollback removes both:

```ts
import { prismaOutboxStore } from '@basaltkit/events-prisma'

const outbox = new Outbox(prismaOutboxStore(prisma, { claim: true }).store)

await prisma.$transaction(async (tx) => {
  await tx.order.update({ where: { id }, data: { status: 'paid' } })
  await outbox.enqueue('order.paid', { id }, { tenantId, tx }) // rolled back with the update
})
```

`tx` is store-specific: the Prisma interactive-transaction client for `@basaltkit/events-prisma`,
the `DatabaseSync` handle running `BEGIN … COMMIT` for `@basaltkit/events-sqlite`.
`MemoryOutboxStore` has no transactions and ignores it. Events recorded by `captureEvents`
(below) are **not** transactional — they are written when `emit()` runs, after (or outside) your
transaction; use an explicit `enqueue(…, { tx })` for events that must never diverge from the data.

If `dispatch` throws, the entry is marked as failed (`attempts + 1`, `lastError`) and is retried on the next `flush` — up to `maxAttempts` (default 10); after that it becomes "dead" and is no longer picked up. Deliveries follow creation order (FIFO).

### `outboxPlugin`: automatic capture + periodic delivery

The plugin wires everything together: captures events from the bus into the outbox and delivers them on a timer.

```ts
import { createApp } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin, MemoryOutboxStore, outboxPlugin } from '@basaltkit/events'

const app = await createApp({
  plugins: [
    eventsPlugin(),
    outboxPlugin({
      store: new MemoryOutboxStore(), // in production: a durable store (database)
      captureEvents: ['invoice.*'],   // patterns to capture automatically into the outbox
      intervalMs: 5000,               // deliver pending entries every 5s
      dispatch: async (entry) => {
        // your actual delivery (e.g. webhook):
        await fetch('https://hooks.example.com', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: entry.event, payload: entry.payload }),
        })
      },
    }),
  ],
}).boot()

const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
await app.container.get(EVENTS).emit(InvoicePaid, { amount: 5 })
// → written to the outbox; delivered on the next 5s cycle

await app.shutdown() // stops the timer and does one last flush (best-effort)
```

Useful details: with `captureEvents`, the plugin depends on `basalt:events` (add the `eventsPlugin`!); if there's an active context with `tenant.id` (via the core's `runWithContext`), the tenant is recorded on each entry; without `intervalMs`, you flush manually with `app.container.get(OUTBOX).flush(dispatch)`.

## API reference

### `defineEvent<T>(name, schema?)`

Creates a `BasaltEvent<T>`: `{ name, schema? }`. `T` defaults to `void` (event without a payload). `schema` is any object with `safeParse` (`EventSchema<T>`, compatible with Zod).

### `EventBus`

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `on(event, handler, options?)` | `BasaltEvent<T>` or `string` (pattern), `EventHandler<T>`, `ListenOptions?` | `() => void` | Subscribes; returns a cancel function. |
| `once(event, handler)` | `BasaltEvent<T>`, `EventHandler<T>` | `() => void` | Shortcut for `on(..., { once: true })`. |
| `emit(event, payload?)` | `BasaltEvent<T>`, payload if `T` is not `void` | `Promise<void>` | Validates (if there's a schema), runs listeners **serially** by priority; aggregates failures into an `AggregateError`. |
| `listenerCount(eventName)` | `string` | `number` | Number of registrations whose pattern matches the name. |

`EventHandler<T>` = `(payload: T, meta: EventMeta) => void | Promise<void>`; `EventMeta` = `{ name: string }`.

`ListenOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `priority` | `number` | no | `0` | Higher runs first. |
| `once` | `boolean` | no | `false` | Removes the listener after the first run. |

### `eventsPlugin()` / `EVENTS`

`eventsPlugin()` returns the `basalt:events` plugin, which registers a singleton `EventBus` in the container under the token `EVENTS` (`Token<EventBus>`).

### Errors

| Error | Code | When |
|---|---|---|
| `EventValidationError` | `EVENT_INVALID` | `emit()` was given a payload that fails the event's schema. Thrown **before** any listener runs, so there are no partial effects. Extends `BasaltError`; carries `event` (the name) and `issues` (the validation details). |
| `AggregateError` | — (built-in) | One or more listeners threw. All matching listeners still ran; `error.errors` holds each individual failure. Also how a failing `captureEvents` write reaches the emitter. |

The outbox itself throws nothing — its failures are per-entry (`markFailed`, then `onDead`) or
store-level (`onFlushError`).

### `Outbox`

`new Outbox(store, options?)`:

| Option (`OutboxOptions`) | Type | Default | Purpose |
|---|---|---|---|
| `maxAttempts` | `number` | `10` | Attempts before an entry is left as **dead** — `pending()` stops selecting it, so it is never flushed again. It stays in the store with its `lastError` for inspection. |
| `backoff` | `OutboxBackoff \| false` | `{ delayMs: 1000, type: 'exponential', maxDelayMs: 60_000 }` | Retry spacing for failed entries. `false` retries on every flush — only sensible when the dispatch target is cheap and local. |
| `onDead` | `(entry: OutboxEntry, error: unknown) => void` | `console.error` naming the event, id and attempt count | Called **once**, at the moment an entry exhausts `maxAttempts`. Dead events should never be silent — this is where you page someone. The `entry` passed carries the post-increment `attempts`. |
| `concurrency` | `number` | `8` | Entries of one flush dispatched in parallel. `1` gives strictly sequential delivery. |
| `tenantConcurrency` | `number` | `ceil(concurrency / 2)` | Most dispatches **one tenant** may have in flight at once, across flushes and including detached ones. Tenant-less entries share one budget. A tenant whose downstream hangs can never hold every worker. |
| `dispatchTimeoutMs` | `number \| false` | `10_000` | How long a flush waits on one dispatch before moving on. The dispatch is **not** cancelled or failed: it keeps running *detached*, its outcome is recorded when it settles, and the entry is not re-dispatched meanwhile (no duplicate, no lost result). `false` waits indefinitely. |
| `claimLeaseMs` | `number` | `300_000` (5 min) | Stores implementing `claim` (multi-replica relays): how long a relay's claim on an entry lasts. While claimed, no other relay dispatches it; if the relay dies mid-dispatch the claim expires and another relay takes over (at-least-once). Must exceed your slowest dispatch. |
| `now` | `() => number` | `Date.now` | Injectable clock; tests drive the backoff windows with it. |

`OutboxBackoff`:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `delayMs` | `number` | `1000` | Base delay before retrying a failed entry. |
| `type` | `'fixed' \| 'exponential'` | `'exponential'` | `'exponential'` doubles per attempt; `'fixed'` keeps `delayMs` constant. |
| `maxDelayMs` | `number` | `60_000` | Ceiling for the exponential delay (the exponent is also clamped at 16, so the delay can never overflow to `Infinity`). |

**Tenant fairness.** One tenant's failing or hanging downstream cannot starve the others. A
flush selects entries oldest-first, but when a page is full of one tenant's backlog it queries
again excluding the tenants already seen (via `pending()`'s filter), then interleaves the batch
round-robin by tenant — each tenant keeps its own FIFO order. Dispatch respects
`tenantConcurrency`, and a flush waits at most `dispatchTimeoutMs` per dispatch, so the relay
keeps ticking for everyone while a hung dispatch finishes on its own.

**Backoff is process-local — unless the store claims.** It is tracked in the relay process's
memory. After a failure, *this* process skips the entry until its delay elapses; with a store
that doesn't implement `claim`, another replica, or this one after a restart, may retry it
sooner (worst case one extra immediate retry). With a claiming store the retry time is also
written to the row (`markFailed(id, error, { retryAt })`), so the backoff holds on every replica.
Delivery stays at-least-once either way.

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `enqueue(event, payload, tenantId?, options?)` / `enqueue(event, payload, { tenantId?, tx? })` | `string`, `unknown`, `string \| OutboxEnqueueOptions`, `OutboxStoreEnqueueOptions?` | `Promise<OutboxEntry>` | Writes an entry with `createdAt = now()`. `tx` makes the write join your transaction (store-specific handle — see *Writing the entry in your transaction*). |
| `flush(dispatch, batchSize?)` | `OutboxDispatch`, `number` (default `50`) | `Promise<FlushResult>` | Delivers up to `batchSize` pending entries (FIFO per tenant, tenants interleaved); marks success/failure per entry. **Overlap-safe** — see below. |

**Overlapping-tick coalescing.** `flush()` keeps the in-flight promise: while one flush is
running, every further call returns *that* promise instead of selecting a batch of its own. This
matters because a slow dispatch (a webhook endpoint that takes 8 s) under a 1 s `intervalMs`
would otherwise have eight timers all reading the same un-published rows and delivering each
entry eight times. With coalescing, the extra ticks simply await the running flush and get its
`FlushResult`. Across processes, coalescing is not enough — two relays on two replicas would
read the same rows. A store that implements **`claim`** fixes that: after selecting a batch the
relay atomically claims it (a conditional update stamping a lease), dispatches only the entries
it won, and `pending()` hides rows another relay holds. `@basaltkit/events-prisma`
(`{ claim: true }`), `@basaltkit/events-sqlite` and `MemoryOutboxStore` implement it. Delivery
is still at-least-once (a relay that dies mid-dispatch loses its claim after `claimLeaseMs`, and
another relay re-sends), so receivers must be idempotent.

`OutboxDispatch` = `(entry: OutboxEntry) => void | Promise<void>`; `FlushResult` = `{ published: number; failed: number; detached?: number }` — `detached` counts dispatches still running when `dispatchTimeoutMs` elapsed (present only when non-zero); their outcome is recorded later and is not counted in this result.

`OutboxEntry`: `id`, `event`, `payload`, `tenantId?`, `createdAt`, `attempts`, `publishedAt?`, `lastError?`.

### Outbox failure hooks

| Hook | Fires when | Default | Receives |
|---|---|---|---|
| `onDead` | An entry exhausts `maxAttempts` — once per entry, at that transition. | `console.error` with event, id and attempts | `(entry: OutboxEntry, error: unknown)` |
| `onFlushError` | A timer/shutdown flush threw at the store level (not a per-entry dispatch failure). | `console.error` `[basalt:outbox] flush failed:` | `(error: unknown)` |

Neither may throw. Both have non-silent defaults, so an unconfigured app still surfaces the
fault instead of losing it.

### `OutboxStore` / `MemoryOutboxStore`

Persistence interface:

| Method | Description |
|---|---|
| `enqueue(entry, options?)` | Writes an entry. `options.tx` (`OutboxStoreEnqueueOptions`) is the transaction to write it in — its type is store-specific; stores without transactions ignore it. |
| `pending(limit, maxAttempts, filter?)` | Unpublished, below the attempt limit, oldest first. `filter` is an `OutboxPendingFilter` — `{ excludeTenantIds?: string[]; excludeGlobal?: boolean; now?: number }` — that lets the relay look past tenants it won't dispatch now (a store may ignore the tenant part: the outbox re-filters every row, but fairness is then limited to what one page holds). `now` is only passed to claiming stores: hide rows whose claim is still active at that instant. |
| `claim?(ids, { token, until, now })` | **Optional.** Atomically claims the given entries for one relay and returns the ids it won: only rows still unpublished whose previous claim expired (`lockedUntil <= now`, or none) — a conditional `UPDATE`, atomic across processes. Implement it and several relays can share the store without double-dispatching. |
| `markPublished(id, at)` | Marks delivered (and releases the claim). |
| `markFailed(id, error, options?)` | `attempts + 1`, `lastError`; releases the claim, or — with `options.retryAt` — keeps the row unclaimable until then (cross-replica backoff). |
| `all()` | Every entry, for inspection. |

`MemoryOutboxStore` implements all of it in memory (fine for dev/tests; **does not survive restarts** and has no transactions — in production use `@basaltkit/events-prisma` / `@basaltkit/events-sqlite` or implement `OutboxStore` over your database).

### `outboxPlugin(options)` / `OUTBOX`

Returns the `basalt:outbox` plugin; registers `Outbox` under the token `OUTBOX` (`Token<Outbox>`).

| Option (`OutboxPluginOptions`) | Type | Required? | Default | Description |
|---|---|---|---|---|
| `dispatch` | `OutboxDispatch` | **yes** | — | Delivers an entry externally (webhooks, Kafka, …). |
| `store` | `OutboxStore` | no | `new MemoryOutboxStore()` | Durable store for entries. |
| `captureEvents` | `string[]` | no | `[]` | Event patterns to capture automatically (requires `eventsPlugin`). |
| `intervalMs` | `number` | no | — | Automatic flush interval, in ms. Omit for manual flush via `OUTBOX`. |
| `batchSize` | `number` | no | `50` | Maximum entries per flush. |
| `onFlushError` | `(error: unknown) => void` | no | `console.error` prefixed `[basalt:outbox] flush failed:` | A **timer or shutdown flush failed at the store level** — e.g. `pending()` threw because the database is unreachable. Per-entry dispatch failures are *not* this: those are caught inside the flush and recorded on the entry. Must never throw. |
| `maxAttempts`, `backoff`, `onDead`, `concurrency`, `tenantConcurrency`, `dispatchTimeoutMs`, `claimLeaseMs`, `now` | — | no | see `OutboxOptions` | Inherited from `OutboxOptions`. |

On `shutdown`, the plugin stops the timer and performs one last best-effort `flush`; if that one
throws, it goes to `onFlushError` too.

#### Why `onFlushError` exists

The timer calls `void outbox.flush(dispatch, batchSize).catch(onFlushError)`. Without the catch,
a store outage would produce an unhandled promise rejection on every tick — process-fatal under
Node's default. With it, the relay keeps ticking and you get one report per failed tick. Route it
to your logger and alert on a sustained rate: a store that can't be read is a relay that has
silently stopped delivering.

#### Awaited capture

Listeners installed by `captureEvents` are **awaited**. If the outbox write fails, the failure
propagates into `EventBus.emit`, which aggregates listener failures into an `AggregateError` —
so the emitter finds out. This is deliberate and it is the whole contract: the outbox promises
that nothing is lost after commit, so a capture that silently dropped the event while the caller
believed it was recorded would break the one guarantee the pattern exists to provide.

The practical consequence: `emit()` is now as slow and as failure-prone as your outbox store. Put
the store in the same database as your business writes (`@basaltkit/events-prisma`) so the write
is local. Capture itself runs at `emit()` time and does **not** join your transaction; for events
that must commit atomically with the data, call `outbox.enqueue(event, payload, { tx })` inside it.

## Common errors and solutions (FAQ)

**"Invalid payload for event …" (`EVENT_INVALID`)** — The payload doesn't match the event's schema. Fix the object passed to `emit`; no listener ran, so there are no partial effects.

**`emit` threw `AggregateError`** — One or more listeners failed, but all of them ran. Inspect `error.errors` to see each individual failure. Decide whether to rethrow or just log it.

**I subscribed to `order.*` but I don't catch `order.payment.failed`** — `*` matches exactly one segment. Use `order.**` for any depth.

**Plugin "basalt:outbox" depends on "basalt:events"** — You used `captureEvents` without adding `eventsPlugin()` to the application. Add it to the `plugins` list.

**`emit()` threw an `AggregateError` mentioning the outbox** — Capture listeners are *awaited*, so a failing outbox write fails the emit. That is intentional (nothing may be silently dropped after commit). Fix the store; don't swallow the error.

**I lost outbox entries after restarting** — You're using `MemoryOutboxStore`, which only lives in memory. In production use a durable store (`@basaltkit/events-prisma`, `@basaltkit/events-sqlite`) and write the entry in the same transaction as the state change: `outbox.enqueue(event, payload, { tx })`.

**An entry stopped being delivered** — It reached `maxAttempts` and became "dead". `onDead` fired once at that moment (default `console.error`). Query `store.all()` and look at `attempts` and `lastError` to diagnose; fix the cause and re-enqueue it if needed.

**Nothing is being delivered and there are no per-entry errors** — The flush itself is failing before it reads a batch. Check `onFlushError` output (default `console.error`, `[basalt:outbox] flush failed:`) — that is a store-level fault, not a dispatch fault.

**A retry didn't happen as soon as I expected** — `backoff` (default exponential from 1 s, capped at 60 s) holds the entry back in *this* process. Pass `backoff: false` to retry on every flush.

**The same event was delivered twice** — Delivery is *at-least-once* by definition (e.g. a crash between `dispatch` and `markPublished`). The receiver should be idempotent — use `entry.id` to deduplicate. If it happens routinely with several replicas, your store doesn't claim: enable `prismaOutboxStore(prisma, { claim: true })` (or implement `OutboxStore.claim`).

## Outbox reliability semantics, in one place

- **Capture is awaited.** A failed outbox write fails the `emit()` that triggered it — nothing is
  silently dropped between "the caller thinks it's recorded" and "it's recorded".
- **Flushes coalesce.** Overlapping timer ticks share one in-flight flush, so a slow dispatch
  can't cause the same batch to be delivered N times. Per process only.
- **Writes can join your transaction.** `enqueue(event, payload, { tx })` writes through the
  store's transaction handle, so the entry commits or rolls back with the state change.
- **Relays claim across replicas.** With a store implementing `claim`, a batch is claimed with a
  leased conditional update before dispatch; other relays skip it until it is published, failed,
  or the lease (`claimLeaseMs`) expires.
- **Failed entries back off.** Exponential from 1 s, capped at 60 s, tracked in the relay
  process's memory — and, with a claiming store, on the row too (so every replica honours it).
- **Dead entries are reported once.** `onDead` fires at the `maxAttempts` transition; the entry
  stays in the store with its `lastError`.
- **Store faults are reported per tick.** `onFlushError` catches them so the relay keeps running
  instead of dying on an unhandled rejection.
- **Delivery is at-least-once.** A crash between `dispatch` and `markPublished` redelivers.
  Receivers must deduplicate on `entry.id`.

## How it connects to other modules

- **`@basaltkit/core`** — `eventsPlugin` and `outboxPlugin` are core plugins; `EVENTS` and `OUTBOX` are container tokens; `EventValidationError` extends `BasaltError`. The outbox reads the tenant from the core context (`tryCtx()?.tenant?.id`) when writing captured events. Note the difference from the core's `HookBus`: hooks are the framework's internal infrastructure (lifecycle, extensions); `EventBus` is for events **from your business domain**, with validation and wildcards.
- **`@basaltkit/config`** — no direct connection; use it to store outbox settings (intervals, destination URLs) and read them when building `outboxPlugin`.
- **`@basaltkit/env`** — the Zod schemas you use in `defineEnv` follow the same style as the ones you pass to `defineEvent`; use `env` for the credentials/URLs your `dispatch` needs.
