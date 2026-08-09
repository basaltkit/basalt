# @machize/events-sqlite

Durable, SQLite-backed implementation of the [`@machize/events`](https://github.com/Zebedeu/machize/tree/main/packages/events) `OutboxStore` (the transactional outbox), on Node's built-in `node:sqlite`. Zero external dependencies.

The whole point of the transactional outbox is to survive a crash **between "committed" and "delivered"** — so its store has to be durable. `@machize/events` ships `MemoryOutboxStore` by default, which loses every un-relayed event when the process exits. This package is the drop-in durable replacement for a single node; the production, multi-instance counterpart is [`@machize/events-prisma`](https://github.com/Zebedeu/machize/tree/main/packages/events-prisma).

## Installation

```bash
pnpm add @machize/events @machize/events-sqlite
```

Requires **Node 22.5+** (`node:sqlite` is stable and flag-free on Node 24; on Node 22.x run with `--experimental-sqlite`).

## Usage

`sqliteOutboxStore()` opens (or creates) the database, applies an idempotent schema, and returns the store named to drop straight into `outboxPlugin`:

```ts
import { outboxPlugin } from '@machize/events'
import { sqliteOutboxStore } from '@machize/events-sqlite'

const outbox = sqliteOutboxStore('./data/outbox.db') // ':memory:' by default

outboxPlugin({
  store: outbox.store,
  captureEvents: ['order.*', 'invoice.*'], // record these domain events durably
  dispatch: async (entry) => sendToWebhook(entry), // relay to the outside world
  intervalMs: 1000, // flush on a timer
})
```

Domain events matching `captureEvents` are written to SQLite as they fire; the relay delivers each **at least once** and marks it published. A crash between capture and delivery loses nothing — pending entries are still there on restart.

## The model

One `outbox` table holds each entry: `event`, JSON `payload`, optional `tenant_id`, `created_at`, `attempts`, `published_at` and `last_error`. A **partial index** on un-published rows keeps the relay's "what's pending?" scan cheap no matter how much published history accumulates.

`SqliteOutboxStore` implements the full `OutboxStore` contract — `enqueue`, `pending(limit, maxAttempts)` (unpublished, below the attempt ceiling, oldest first), `markPublished`, `markFailed` (increments `attempts`), `all`. Re-enqueuing the same `id` replaces the entry, mirroring `MemoryOutboxStore`. `sqliteOutboxStore()` also exposes the raw `db` handle.

## Which backend?

- **`@machize/events-sqlite`** — a single node, zero dependencies, the outbox in a local file.
- **`@machize/events-prisma`** — you already run Postgres/MySQL, or need the outbox in the same database (and transaction) as your business writes.

Both implement the identical `OutboxStore` contract, so switching is a one-line change.
