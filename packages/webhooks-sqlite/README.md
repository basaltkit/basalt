# @basaltkit/webhooks-sqlite

Durable, SQLite-backed implementation of the [`@basaltkit/webhooks`](https://github.com/Zebedeu/basalt/tree/main/packages/webhooks) `WebhookStore` (outbound endpoint subscriptions), on Node's built-in `node:sqlite`. Zero external dependencies.

`@basaltkit/webhooks` ships `MemoryWebhookStore` by default, which forgets every registered endpoint when the process exits — so after a redeploy, nobody is subscribed and events silently stop being delivered. This package persists the subscriptions for a single node; the production, multi-instance counterpart is [`@basaltkit/webhooks-prisma`](https://github.com/Zebedeu/basalt/tree/main/packages/webhooks-prisma).

## Installation

```bash
pnpm add @basaltkit/webhooks @basaltkit/webhooks-sqlite
```

Requires **Node 22.5+** (`node:sqlite` is stable and flag-free on Node 24; on Node 22.x run with `--experimental-sqlite`).

## Usage

`sqliteWebhookStore()` opens (or creates) the database, applies an idempotent schema, and returns the store named to drop straight into `webhooksPlugin`:

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { sqliteWebhookStore } from '@basaltkit/webhooks-sqlite'

const webhooks = sqliteWebhookStore('./data/webhooks.db') // ':memory:' by default

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

Register endpoints via the `WEBHOOKS` manager as usual; they now survive a restart.

## The model

One `webhook_endpoints` table holds each subscription: `url`, its `events` patterns (JSON array), optional `tenant_id`, per-endpoint `secret` and `active` flag. `SqliteWebhookStore` implements the full `WebhookStore` contract:

| Method | Description |
| --- | --- |
| `add(endpoint)` | Register an endpoint (auto `id` if omitted); re-adding an id replaces it. |
| `forEvent(event, tenantId?)` | Active endpoints whose patterns match, scoped to the tenant (tenant-agnostic endpoints always match). |
| `list(tenantId?)` | Every endpoint, optionally filtered by exact tenant. |
| `remove(id)` | Delete an endpoint. |

Event matching (`*`, `prefix.*`, exact) reuses `matchesEvent` from `@basaltkit/webhooks`, so it behaves identically to the in-memory store. `sqliteWebhookStore()` also exposes the raw `db` handle.

## Which backend?

- **`@basaltkit/webhooks-sqlite`** — a single node, zero dependencies, subscriptions in a local file.
- **`@basaltkit/webhooks-prisma`** — you already run Postgres/MySQL, or need several instances to share one set of subscriptions.

Both implement the identical `WebhookStore` contract, so switching is a one-line change.
