<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/webhooks-prisma

Prisma-backed implementation of the [`@basaltkit/webhooks`](https://github.com/basaltkit/basalt/tree/main/packages/webhooks) `WebhookStore` (outbound endpoint subscriptions) — the production reference backend for PostgreSQL/MySQL. Bring your own `PrismaClient`; the package ships a reference schema.

`@basaltkit/webhooks` ships `MemoryWebhookStore` by default — fine for tests and dev, but it forgets every registered endpoint on restart and can't be shared across instances. This package persists the subscriptions in the database you already run. The single-node, zero-dependency counterpart is [`@basaltkit/webhooks-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/webhooks-sqlite).

## Installation

```bash
pnpm add @basaltkit/webhooks @basaltkit/webhooks-prisma
```

## Schema

Don't hand-copy the model — run **`basalt prisma:sync`** (from [`@basaltkit/prisma`](https://github.com/basaltkit/basalt/tree/main/packages/prisma)), which discovers every installed `@basaltkit/*-prisma` package and merges its models into your `prisma/schema.prisma`:

```bash
pnpm basalt prisma:sync --push        # add the WebhookEndpoint model + create the table
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
import { webhooksPlugin } from '@basaltkit/webhooks'
import { prismaWebhookStore } from '@basaltkit/webhooks-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const webhooks = prismaWebhookStore(prisma)

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

Wire the store before its model exists and it **fails fast** with a message naming the missing model and pointing you at `basalt prisma:sync` — no cryptic `reading 'upsert' of undefined`.

## API

`PrismaWebhookStore` implements the full `WebhookStore` contract — `add` (auto `id`; re-adding an id replaces it), `forEvent(event, tenantId?)` (active, tenant-scoped, event-pattern matched), `list(tenantId?)`, `remove`. Event patterns are stored as a JSON array; matching (`*`, `prefix.*`, exact) reuses `matchesEvent` from `@basaltkit/webhooks`, identical to the memory store.

## Which backend?

- **`@basaltkit/webhooks-prisma`** — you already run Postgres/MySQL, or need multiple instances sharing one set of subscriptions.
- **`@basaltkit/webhooks-sqlite`** — a single node with zero dependencies.

Both implement the identical `WebhookStore` contract, so switching is a one-line change.
