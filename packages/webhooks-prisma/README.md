# @machize/webhooks-prisma

Prisma-backed implementation of the [`@machize/webhooks`](https://github.com/Zebedeu/machize/tree/main/packages/webhooks) `WebhookStore` (outbound endpoint subscriptions) — the production reference backend for PostgreSQL/MySQL. Bring your own `PrismaClient`; the package ships a reference schema.

`@machize/webhooks` ships `MemoryWebhookStore` by default — fine for tests and dev, but it forgets every registered endpoint on restart and can't be shared across instances. This package persists the subscriptions in the database you already run. The single-node, zero-dependency counterpart is [`@machize/webhooks-sqlite`](https://github.com/Zebedeu/machize/tree/main/packages/webhooks-sqlite).

## Installation

```bash
pnpm add @machize/webhooks @machize/webhooks-prisma
```

## Schema

Don't hand-copy the model — run **`mach prisma:sync`** (from [`@machize/prisma`](https://github.com/Zebedeu/machize/tree/main/packages/prisma)), which discovers every installed `@machize/*-prisma` package and merges its models into your `prisma/schema.prisma`:

```bash
pnpm mach prisma:sync --push        # add the WebhookEndpoint model + create the table
```

Or copy the reference model from [`prisma/schema.prisma`](./prisma/schema.prisma):

```prisma
model WebhookEndpoint {
  id       String   @id
  url      String
  events   String   // JSON array of event patterns
  tenantId String?
  secret   String?
  active   Boolean?
  @@index([tenantId])
  @@map("webhook_endpoints")
}
```

Then `prisma generate` and go.

## Usage

Pass your generated client directly — no cast:

```ts
import { webhooksPlugin } from '@machize/webhooks'
import { prismaWebhookStore } from '@machize/webhooks-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const webhooks = prismaWebhookStore(prisma)

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

Wire the store before its model exists and it **fails fast** with a message naming the missing model and pointing you at `mach prisma:sync` — no cryptic `reading 'upsert' of undefined`.

## API

`PrismaWebhookStore` implements the full `WebhookStore` contract — `add` (auto `id`; re-adding an id replaces it), `forEvent(event, tenantId?)` (active, tenant-scoped, event-pattern matched), `list(tenantId?)`, `remove`. Event patterns are stored as a JSON array; matching (`*`, `prefix.*`, exact) reuses `matchesEvent` from `@machize/webhooks`, identical to the memory store.

## Which backend?

- **`@machize/webhooks-prisma`** — you already run Postgres/MySQL, or need multiple instances sharing one set of subscriptions.
- **`@machize/webhooks-sqlite`** — a single node with zero dependencies.

Both implement the identical `WebhookStore` contract, so switching is a one-line change.
