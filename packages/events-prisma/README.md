<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/events-prisma

Prisma-backed implementation of the [`@basaltkit/events`](https://github.com/basaltkit/basalt/tree/main/packages/events) `OutboxStore` (the transactional outbox) — the production reference backend for PostgreSQL/MySQL. Bring your own `PrismaClient`; the package ships a reference schema.

`@basaltkit/events` ships `MemoryOutboxStore` by default — fine for tests and dev, but it loses every un-relayed event on restart and can't be shared across instances. This package keeps the outbox in the database you already run, so delivery stays **at-least-once and crash-safe**. The single-node, zero-dependency counterpart is [`@basaltkit/events-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/events-sqlite).

## Why the same database matters

The transactional outbox only holds its promise when the event is written **in the same transaction** as the state change it describes — commit both or neither. Putting the outbox in your primary Postgres/MySQL (this package) makes that possible; a separate store can't.

## Installation

```bash
pnpm add @basaltkit/events @basaltkit/events-prisma
```

## Schema

Don't hand-copy the model — run **`basalt prisma:sync`** (from [`@basaltkit/prisma`](https://github.com/basaltkit/basalt/tree/main/packages/prisma)), which discovers every installed `@basaltkit/*-prisma` package and merges its models into your `prisma/schema.prisma`:

```bash
pnpm basalt prisma:sync --push        # add the OutboxEntry model + create the table
```

Or copy the reference model from [`prisma/schema.prisma`](./prisma/schema.prisma):

```prisma
model OutboxEntry {
  id          String    @id
  event       String
  payload     String?   // JSON-serialized payload
  tenantId    String?
  createdAt   DateTime
  attempts    Int       @default(0)
  publishedAt DateTime?
  lastError   String?
  @@index([publishedAt, createdAt])
  @@map("outbox")
}
```

Then `prisma generate` and go.

## Usage

Pass your generated client directly — no cast:

```ts
import { outboxPlugin } from '@basaltkit/events'
import { prismaOutboxStore } from '@basaltkit/events-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const outbox = prismaOutboxStore(prisma)

outboxPlugin({
  store: outbox.store,
  captureEvents: ['order.*', 'invoice.*'],
  dispatch: async (entry) => sendToWebhook(entry),
  intervalMs: 1000,
})
```

Wire the store before its model exists and it **fails fast** with a message naming the missing model and pointing you at `basalt prisma:sync` — no cryptic `reading 'upsert' of undefined`.

## API

| Export | Signature | Purpose |
|---|---|---|
| `prismaOutboxStore` | `(client: PrismaEventsClient) => { store: PrismaOutboxStore }` | The one you want. Validates the model exists, then returns the store — drop `store` into `outboxPlugin({ store })`. |
| `PrismaOutboxStore` | `new PrismaOutboxStore(client)` | The store itself, without the model check. |
| `PrismaEventsClient` | type | The minimal delegate surface used: `outboxEntry.upsert` / `findMany` / `updateMany`. A real `PrismaClient` with the `OutboxEntry` model is assignable, so pass it directly — no cast. |

### Options

`prismaOutboxStore` takes no options object: everything tunable (`maxAttempts`, `backoff`,
`onDead`, `batchSize`, `intervalMs`, `onFlushError`) lives on `outboxPlugin` /
`OutboxOptions` in [`@basaltkit/events`](https://www.npmjs.com/package/@basaltkit/events). The
only decision here is which `PrismaClient` you hand it — and the answer is the one that owns your
business writes, so the enqueue can join their transaction.

### Contract details

`PrismaOutboxStore` implements the full `OutboxStore` contract — `enqueue`, `pending(limit, maxAttempts)` (unpublished, below the attempt ceiling, oldest first, tie-broken by `id`), `markPublished`, `markFailed` (increments `attempts`), `all`. Payloads are JSON-serialized into a text column; time is stored as `DateTime` and exposed as epoch-ms, matching the contract. Re-enqueuing the same `id` **replaces** the entry (`upsert` resets `attempts` to 0 and clears `publishedAt`/`lastError`), mirroring `MemoryOutboxStore`. `markPublished` and `markFailed` use `updateMany`, so a missing id is a no-op rather than a throw — again matching the memory store.

### Errors

| Error | Code | When |
|---|---|---|
| Plain `Error` — *"@basaltkit/events-prisma: the Prisma client has no `outboxEntry` model…"* | — | Thrown by `prismaOutboxStore()` at wiring time when the client lacks the model. The message names the missing delegate and points at `basalt prisma:sync`. A lazy/proxy client (database-per-tenant) skips the check and is validated at first use instead. |
| Prisma client errors (`PrismaClientKnownRequestError`, …) | — | Propagate from the delegate. They reach you through the outbox's `onFlushError` (store-level, e.g. `pending()` failing) or as the entry's `lastError`. |

This package defines no `BasaltError` subclasses.

### Hooks & events

None — this package is a storage adapter. The outbox's callbacks (`onDead`, `onFlushError`) and
its retry policy live on `outboxPlugin` / `OutboxOptions` in
[`@basaltkit/events`](https://www.npmjs.com/package/@basaltkit/events).

## Which backend?

- **`@basaltkit/events-prisma`** — you already run Postgres/MySQL, or need the outbox in the same database (and transaction) as your writes.
- **`@basaltkit/events-sqlite`** — a single node with zero dependencies.

Both implement the identical `OutboxStore` contract, so switching is a one-line change.
