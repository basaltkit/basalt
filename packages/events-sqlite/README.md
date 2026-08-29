<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/events-sqlite

Durable, SQLite-backed implementation of the [`@basaltkit/events`](https://github.com/basaltkit/basalt/tree/main/packages/events) `OutboxStore` (the transactional outbox), on Node's built-in `node:sqlite`. Zero external dependencies.

The whole point of the transactional outbox is to survive a crash **between "committed" and "delivered"** — so its store has to be durable. `@basaltkit/events` ships `MemoryOutboxStore` by default, which loses every un-relayed event when the process exits. This package is the drop-in durable replacement for a single node; the production, multi-instance counterpart is [`@basaltkit/events-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/events-prisma).

## Installation

```bash
pnpm add @basaltkit/events @basaltkit/events-sqlite
```

Requires **Node 22.5+** (`node:sqlite` is stable and flag-free on Node 24; on Node 22.x run with `--experimental-sqlite`).

## Usage

`sqliteOutboxStore()` opens (or creates) the database, applies an idempotent schema, and returns the store named to drop straight into `outboxPlugin`:

```ts
import { outboxPlugin } from '@basaltkit/events'
import { sqliteOutboxStore } from '@basaltkit/events-sqlite'

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

`SqliteOutboxStore` implements the full `OutboxStore` contract — `enqueue`, `pending(limit, maxAttempts)` (unpublished, below the attempt ceiling, oldest first), `markPublished`, `markFailed` (increments `attempts`), `all`. Re-enqueuing the same `id` replaces the entry (`INSERT OR REPLACE`: `attempts` reset to 0, publish/error cleared), mirroring `MemoryOutboxStore`. `sqliteOutboxStore()` also exposes the raw `db` handle.

## API reference

| Export | Signature | Purpose |
|---|---|---|
| `sqliteOutboxStore` | `(dbOrLocation?: DatabaseSync \| string) => { db, store }` | The one you want. Opens (or reuses) the database, migrates it, returns `{ db, store }` — drop `store` into `outboxPlugin({ store })`. |
| `openOutboxDatabase` | `(location?: string) => DatabaseSync` | Opens and migrates a database without building the store. |
| `migrate` | `(db: DatabaseSync) => void` | Applies the idempotent schema to a `DatabaseSync` you already own. Safe to call repeatedly. |
| `SqliteOutboxStore` | `new SqliteOutboxStore(db: DatabaseSync)` | The store itself, if you manage the handle. |

### Options

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `dbOrLocation` | `string` | `':memory:'` | File path for the SQLite database — **use a real path in production**; the default is in-memory and therefore not durable, which defeats the point of the outbox. |
| `dbOrLocation` | `DatabaseSync` | — | An open handle to reuse (it is migrated in place) so the outbox shares one connection with the rest of your app. |
| `location` (`openOutboxDatabase`) | `string` | `':memory:'` | Same. |

### Pragmas the migration sets

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | The relay reads while your request handlers write; WAL lets both proceed. |
| `busy_timeout` | `5000` | Waits up to 5 s for a competing writer's lock instead of throwing `database is locked` immediately — smooths over dev reloads and concurrency. |

### Errors

| Error | Code | When |
|---|---|---|
| — | — | This package throws no error classes of its own. Failures surface as `node:sqlite` errors from the underlying statement, and reach you through the outbox's `onFlushError` (store-level) or the entry's `lastError` (per-entry). |
| `ERR_UNKNOWN_BUILTIN_MODULE` / import failure | — | Node is older than 22.5, or 22.x without `--experimental-sqlite`. The `node:sqlite` import fails at module load. |

### Hooks & events

None — this package is a storage adapter. The outbox's callbacks (`onDead`, `onFlushError`) and
its retry policy live on `outboxPlugin` / `OutboxOptions` in
[`@basaltkit/events`](https://www.npmjs.com/package/@basaltkit/events).

## Which backend?

- **`@basaltkit/events-sqlite`** — a single node, zero dependencies, the outbox in a local file.
- **`@basaltkit/events-prisma`** — you already run Postgres/MySQL, or need the outbox in the same database (and transaction) as your business writes.

Both implement the identical `OutboxStore` contract, so switching is a one-line change.
