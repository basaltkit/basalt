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
  // secret rotation (WebhookManager.rotateSecret())
  previousSecret          String?
  previousSecretExpiresAt DateTime?
  @@index([tenantId])
  @@map("webhook_endpoints")
}
```

Then `prisma generate` and go.

> **Secret rotation columns.** `previousSecret` and `previousSecretExpiresAt` hold the replaced secret during a `rotateSecret()` grace window (both secrets sign until it ends). The store writes them only when an endpoint carries rotation state. A schema from an earlier version, without the two columns, keeps working for everything else. Add them (`basalt prisma:sync`, then migrate) before calling `rotateSecret()`.

> **MySQL:** Prisma maps `String` to `VARCHAR(191)` there (to `text` on PostgreSQL). Endpoint URLs and event lists can be longer: annotate `url` and `events` with `@db.Text` in your schema, or long values are rejected (`P2000`) — or truncated, with a non-strict `sql_mode`. The reference schema stays provider-neutral so it can be copied into any datasource.

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

Under schema- or database-per-tenant, either keep the webhook tables central
(pass the plain client — the simplest option, everything works unchanged) or
keep each tenant's endpoints in its own database through `tenantClient()`:

```ts
import { tenantClient } from '@basaltkit/prisma'

webhooksPlugin({ store: prismaWebhookStore(tenantClient<PrismaClient>()).store, secretBox })
webhookOutboxPlugin({ store: centralOutboxStore, tenantOnly: true }) // outbox stays central
```

With `tenancyPlugin` registered, off-request dispatches (the outbox relay
included) enter each entry's tenant for the endpoint lookup automatically. See
the [webhooks guide](https://basaltkit-docs.pages.dev/guide/webhooks#schema-per-tenant).

Wire the store before its model exists and it **fails fast** with a message naming the missing model and pointing you at `basalt prisma:sync` — no cryptic `reading 'updateMany' of undefined`.

## API

`PrismaWebhookStore` implements the full `WebhookStore` contract — `add` (auto `id`; re-adding an id replaces it **within its own scope** — an id held by another tenant, or by a global endpoint, is refused with `WebhookEndpointIdInUseError` (409 — the `@basaltkit/webhooks` class, re-exported here, so `instanceof` works whichever store threw it), also when it differs only in letter case on a case-insensitive MySQL collation; the write is keyed by `(id, tenantId)`, never by `id` alone), `forEvent(event, tenantId?)` (active, tenant-scoped, event-pattern matched; fail-closed — with no tenant only tenant-agnostic endpoints are returned), `list(tenantId?)`, `remove`. Event patterns are stored as a JSON array; matching (`*`, `prefix.*`, exact) reuses `matchesEvent` from `@basaltkit/webhooks`, identical to the memory store.

## MySQL

The reference schema above is written for PostgreSQL (and works on SQLite),
where a bare `String` is `TEXT`. **On MySQL Prisma makes it `VARCHAR(191)`**,
and a server outside strict mode truncates a longer value silently — the write
succeeds, and the value read back is not the one written. A cut URL delivers every event to a different address, and a cut secret signs with a different key.

- Copy **`schema.mysql.prisma`** instead (exported as
  `@basaltkit/webhooks-prisma/schema.mysql.prisma`; `basalt prisma:sync` picks it when
  your datasource is `mysql`): the free-text columns are widened with native
  types, the keys stay `VARCHAR(191)` so they can be indexed.
- Turn on the guard, so a value that still would not fit is **refused**
  (`ColumnLengthError`, code `COLUMN_LENGTH_EXCEEDED`, status 422, nothing
  written) instead of cut:

  ```ts
  prismaWebhookStore(prisma, { columnLimits: 'mysql' })
  ```

  `'mysql'` is `webhooksMysqlColumnLimits` — the capacities of `schema.mysql.prisma`. A number is
  a limit in characters (`VARCHAR(n)`), `{ bytes: n }` a limit in UTF-8 bytes
  (the `TEXT` family). Widened a column yourself? Spread the preset and raise it:
  `{ WebhookEndpoint: { ...webhooksMysqlColumnLimits.WebhookEndpoint, tenantId: 255 } }`.
- Keep MySQL in strict mode (`STRICT_TRANS_TABLES`) as well.

Unset (the default), nothing is checked — PostgreSQL and SQLite are unaffected.
See the [MySQL section of the persistence guide](https://basaltkit-docs.pages.dev/guide/persistence#mysql).

## Which backend?

- **`@basaltkit/webhooks-prisma`** — you already run Postgres/MySQL, or need multiple instances sharing one set of subscriptions.
- **`@basaltkit/webhooks-sqlite`** — a single node with zero dependencies.

Both implement the identical `WebhookStore` contract, so switching is a one-line change.
