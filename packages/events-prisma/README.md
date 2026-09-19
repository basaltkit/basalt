<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/events-prisma

Prisma-backed implementation of the [`@basaltkit/events`](https://github.com/basaltkit/basalt/tree/main/packages/events) `OutboxStore` (the transactional outbox) — the production reference backend for PostgreSQL/MySQL. Bring your own `PrismaClient`; the package ships a reference schema.

`@basaltkit/events` ships `MemoryOutboxStore` by default — fine for tests and dev, but it loses every un-relayed event on restart and can't be shared across instances. This package keeps the outbox in the database you already run, so delivery stays **at-least-once and crash-safe**. The single-node, zero-dependency counterpart is [`@basaltkit/events-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/events-sqlite).

## Why the same database matters

The transactional outbox only holds its promise when the event is written **in the same transaction** as the state change it describes — commit both or neither. Putting the outbox in your primary Postgres/MySQL (this package) makes that possible; a separate store can't. Pass Prisma's transaction client as `tx` and the entry is written through it:

```ts
await prisma.$transaction(async (tx) => {
  await tx.order.update({ where: { id }, data: { status: 'paid' } })
  await outbox.enqueue('order.paid', { id }, { tenantId, tx }) // outbox = container.get(OUTBOX)
})
// throw inside the callback → Prisma rolls back the update AND the outbox row
```

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
  lockedUntil DateTime? // relay claim lease ({ claim: true })
  lockedBy    String?   // token of the relay holding the row
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
const outbox = prismaOutboxStore(prisma, { claim: true }) // safe with several replicas

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
| `prismaOutboxStore` | `(client: PrismaEventsClient, options?: PrismaOutboxStoreOptions) => { store: PrismaOutboxStore }` | The one you want. Validates the model exists, then returns the store — drop `store` into `outboxPlugin({ store })`. |
| `PrismaOutboxStore` | `new PrismaOutboxStore(client, options?)` | The store itself, without the model check. `enqueue(entry, { tx })` writes through a Prisma transaction client. |
| `PrismaOutboxStoreOptions` | type | `{ claim?: boolean }` — see below. |
| `PrismaOutboxTx` | type | What `tx` must provide: `outboxEntry.upsert` — the `tx` of `prisma.$transaction(async (tx) => …)` is assignable. |
| `PrismaEventsClient` | type | The minimal delegate surface used: `outboxEntry.upsert` / `findMany` / `updateMany`. A real `PrismaClient` with the `OutboxEntry` model is assignable, so pass it directly — no cast. |

### Options

| Option (`PrismaOutboxStoreOptions`) | Type | Default | Purpose |
|---|---|---|---|
| `claim` | `boolean` | `false` | Claim rows before dispatching, so **several relays (one per replica) never deliver the same entry at once**, and a failed entry's retry backoff holds on every replica. Needs the `lockedUntil` / `lockedBy` columns (reference schema; `basalt prisma:sync` + migrate). Off by default only so an existing table without those columns keeps working — turn it on whenever more than one process runs the relay. |

Everything else (`maxAttempts`, `backoff`, `onDead`, `batchSize`, `intervalMs`, `onFlushError`,
`claimLeaseMs`) lives on `outboxPlugin` / `OutboxOptions` in
[`@basaltkit/events`](https://www.npmjs.com/package/@basaltkit/events). Hand it the
`PrismaClient` that owns your business writes, so `enqueue(…, { tx })` can join their transaction.

### How the claim works (multi-replica relays)

After selecting a batch, the relay calls `claim(ids, { token, until, now })`: **one conditional
`updateMany`** — `WHERE id IN (…) AND publishedAt IS NULL AND (lockedUntil IS NULL OR lockedUntil <= now)`
— stamps the relay's token and lease expiry, then a `findMany` by token reads back the rows it
won; only those are dispatched. Postgres and MySQL re-check the `WHERE` of a concurrent `UPDATE`
after the row lock is released, so each row is won by exactly one relay. `pending()` hides rows
with an active claim, `markPublished` releases it, and `markFailed` releases it or holds it
until the retry time. If a relay dies mid-dispatch its lease (`claimLeaseMs`, default 5 min)
expires and another relay takes the row over — at-least-once, never lost.

Why not `SELECT … FOR UPDATE SKIP LOCKED`? It needs a raw query (not portable across
providers, and refused inside a tenant context by the `@basaltkit/prisma` tenancy extension's raw
guard), and the lock only lives as long as a transaction — you'd have to hold a transaction open
across the network dispatch. The lease is plain model queries, works on every Prisma provider,
and survives the relay crashing.

### Contract details

`PrismaOutboxStore` implements the full `OutboxStore` contract — `enqueue` (optionally through `{ tx }`), `claim` (with `{ claim: true }`), `pending(limit, maxAttempts, filter?)` (unpublished, below the attempt ceiling, oldest first, tie-broken by `id`; `filter` excludes tenants — NULL-safe, so tenant-less rows are only dropped by `excludeGlobal` — which lets the relay stay fair across tenants), `markPublished`, `markFailed` (increments `attempts`), `all`. Payloads are JSON-serialized into a text column; time is stored as `DateTime` and exposed as epoch-ms, matching the contract. Re-enqueuing the same `id` **replaces** the entry (`upsert` resets `attempts` to 0 and clears `publishedAt`/`lastError`), mirroring `MemoryOutboxStore`. `markPublished` and `markFailed` use `updateMany`, so a missing id is a no-op rather than a throw — again matching the memory store.

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
