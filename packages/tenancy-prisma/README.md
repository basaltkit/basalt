<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/tenancy-prisma

Prisma-backed implementation of the [`@basaltkit/tenancy`](https://github.com/basaltkit/basalt/tree/main/packages/tenancy) `TenantSource` — the production reference backend for PostgreSQL/MySQL. Bring your own `PrismaClient`; the package ships a reference schema.

`@basaltkit/tenancy` ships an in-memory `MemoryTenantSource` — fine for tests and dev, but it forgets every tenant on restart and can't be shared across instances. This package persists your tenant registry (and their custom domains) in the database you already run. The single-node, zero-dependency counterpart is [`@basaltkit/tenancy-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/tenancy-sqlite).

## Installation

```bash
pnpm add @basaltkit/tenancy @basaltkit/tenancy-prisma
```

## Schema

The source touches two models. Don't hand-copy them — run **`basalt prisma:sync`** (from [`@basaltkit/prisma`](https://github.com/basaltkit/basalt/tree/main/packages/prisma)), which discovers every installed `@basaltkit/*-prisma` package and merges its models into your `prisma/schema.prisma`:

```bash
pnpm basalt prisma:sync --push        # add missing models + create the tables
```

Or copy the reference models from [`prisma/schema.prisma`](./prisma/schema.prisma):

```prisma
model Tenant {
  id      String         @id
  data    Json           // the open tenant record ({ id, ...anything }) as JSON
  domains TenantDomain[]
  @@map("tenants")
}

model TenantDomain {
  domain            String    @id
  tenantId          String
  verificationToken String?   // set on CustomDomains claims (PrismaDomainStore), NULL on tenant.domains mirrors
  verified          Boolean   @default(true)
  createdAt         DateTime  @default(now())
  verifiedAt        DateTime?
  tenant            Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
  @@map("tenant_domains")
}
```

Then `prisma generate` and go. The four verification columns are needed by `PrismaDomainStore` only; upgrading from a version without them is an additive migration (`prisma migrate dev`). `PrismaTenantSource` keeps working on a database not yet migrated as long as the client was generated from the old model; a client generated from the new model reads the new columns, so migrate before you deploy it.

## Verified custom domains — `PrismaDomainStore`

The durable `DomainStore` for `CustomDomains` from `@basaltkit/tenancy`, on the same table:

```ts
import { CustomDomains } from '@basaltkit/tenancy'
import { prismaDomainStore, prismaTenantSource } from '@basaltkit/tenancy-prisma'

const tenants = prismaTenantSource(prisma)
const domains = new CustomDomains({ store: prismaDomainStore(prisma), reservedDomains: ['example.com'] })
```

Rows with a `verificationToken` are claims and belong to the store; rows without one mirror `tenant.domains` and belong to the source. `save()`/`create()` never delete a claim, so `tenancy.provision()` or a status change keeps a verified domain and its proof; and `findByDomain` resolves a claim only once it is verified, so a domain another tenant merely claimed never routes a request. `add()` translates the unique violation (`P2002`) into `DomainTakenError` (409). `replace()` is one conditional `updateMany`, so of two concurrent take-overs exactly one wins.

## Usage

Pass your generated client directly — no cast:

```ts
import { tenancyPlugin, subdomainResolver } from '@basaltkit/tenancy'
import { prismaTenantSource } from '@basaltkit/tenancy-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const tenants = prismaTenantSource(prisma)

await tenants.save({ id: 'acme', name: 'Acme Inc', domains: ['app.acme.com'] })

tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'localhost' })],
})
```

Wire the source before its models exist and it **fails fast** with a message naming the missing model and pointing you at `basalt prisma:sync` — no cryptic `reading 'upsert' of undefined`.

## The model & API

A tenant is an **open record** (`{ id, ...anything }`), stored in a `Json` column so any per-tenant fields round-trip unchanged. Custom domains (`tenant.domains: string[]`) are normalized into the indexed `TenantDomain` table, so `findByDomain` (used by the domain resolver) is a keyed lookup.

`PrismaTenantSource` implements the full `TenantSource` contract plus writes: `create` (insert-only + the domain set), `save` (upsert + sync the domain set — claim rows are left alone), `find`, `findByDomain`, `list`, `remove` (cascades domains). **Domains are globally unique** — `create` and `save` reject a domain already owned by a different tenant, so routing stays unambiguous. Each write runs in **one interactive transaction** (`$transaction`): the tenant row, the domain check and the domain set commit together or not at all, so a failure part-way — a domain another tenant claimed a moment earlier, a lost connection — never leaves a tenant rewritten with its domains deleted. A domain listed twice is stored once.

## Options reference

`prismaTenantSource(client, options?)` takes one option, `columnLimits`
(`'mysql'` or your own limits — see [MySQL](#mysql)); unset, nothing is
checked. Resolvers, `required`, `onMigrate` and `onSeed` belong to `tenancyPlugin`.

| Export | Kind | Purpose |
| --- | --- | --- |
| `prismaTenantSource(client, options?)` | function | Validates the client and returns a `PrismaTenantSource`. |
| `tenancyMysqlColumnLimits` / `ColumnLengthError` | const / class | The MySQL preset and the error the guard throws. |
| `PrismaTenantSource` | class | The `TenantSource` implementation plus `save` and `remove`. `new PrismaTenantSource(client, options?)`. |
| `PrismaTenancyClient` | interface | The two delegates the source touches — `tenant` (`findUnique`, `findMany`, `create`, `upsert`, `deleteMany`), `tenantDomain` — plus `$transaction(fn)`. A generated `PrismaClient` satisfies it. |

| Method | Description |
| --- | --- |
| `create(tenant)` | Insert a **new** tenant and its domain set. An existing id throws `TenantAlreadyExistsError` (409) and leaves that tenant untouched — the insert's unique violation (`P2002`) is what refuses it, so of two concurrent creates exactly one wins. What `tenancy.create()` calls. |
| `save(tenant)` | Upsert the tenant (replacing the whole record) and bring its mirror rows in line with `tenant.domains` (drops unlisted ones, inserts missing ones; `PrismaDomainStore` claims are never deleted). For intentional updates and status transitions. Atomic: a conflicting domain rolls the whole save back. |
| `find(id)` | The tenant record, or `null`. |
| `findByDomain(domain)` | The tenant owning that domain, or `null`. A `PrismaDomainStore` claim resolves only once verified (fail-closed). |
| `list()` | Every tenant, ordered by `id`. |
| `remove(id)` | Delete a tenant; its domains cascade. Returns whether one existed. |

## MySQL

The reference schema above is written for PostgreSQL (and works on SQLite),
where a bare `String` is `TEXT`. **On MySQL Prisma makes it `VARCHAR(191)`**,
and a server outside strict mode truncates a longer value silently — the write
succeeds, and the value read back is not the one written. Two long domains cut to the same prefix collide, and a cut domain resolves nobody. The MySQL variant makes `domain` `VARCHAR(255)` (a DNS name reaches 253); the tenant record itself is `Json`, which MySQL stores whole. The check runs before the transaction, so a refused tenant writes nothing.

- Copy **`schema.mysql.prisma`** instead (exported as
  `@basaltkit/tenancy-prisma/schema.mysql.prisma`; `basalt prisma:sync` picks it when
  your datasource is `mysql`): the free-text columns are widened with native
  types, the keys stay `VARCHAR(191)` so they can be indexed.
- Turn on the guard, so a value that still would not fit is **refused**
  (`ColumnLengthError`, code `COLUMN_LENGTH_EXCEEDED`, status 422, nothing
  written) instead of cut:

  ```ts
  prismaTenantSource(prisma, { columnLimits: 'mysql' })
  ```

  `'mysql'` is `tenancyMysqlColumnLimits` — the capacities of `schema.mysql.prisma`. A number is
  a limit in characters (`VARCHAR(n)`), `{ bytes: n }` a limit in UTF-8 bytes
  (the `TEXT` family). Widened a column yourself? Spread the preset and raise it:
  `{ TenantDomain: { ...tenancyMysqlColumnLimits.TenantDomain, tenantId: 255 } }`.
- Keep MySQL in strict mode (`STRICT_TRANS_TABLES`) as well.

Unset (the default), nothing is checked — PostgreSQL and SQLite are unaffected.
See the [MySQL section of the persistence guide](https://basaltkit-docs.pages.dev/guide/persistence#mysql).

## Errors

This package defines no `BasaltError` subclasses and no error codes of its own —
it throws `@basaltkit/tenancy`'s `TenantAlreadyExistsError` for a duplicate id,
and plain `Error`s for the two other conditions it owns:

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `Error` | — | boot / first use | The client has no `tenant` model. `prismaTenantSource()` fails fast naming the missing model and pointing at `basalt prisma:sync`, instead of a cryptic "reading 'upsert' of undefined". A lazy/proxy client (database-per-tenant) skips the check and is validated on first query. |
| `ColumnLengthError` | `COLUMN_LENGTH_EXCEEDED` | 422 | With `columnLimits`, a tenant id or domain is longer than its column. Checked before the transaction: nothing is written. |
| `TenantAlreadyExistsError` | `TENANT_ALREADY_EXISTS` | 409 | `create()` for an id that already exists (Prisma `P2002` on the tenant insert). The existing record is left as it was. |
| `Error` | — | 500 | `save()` or `create()` was given a domain already owned by a **different** tenant. Checked inside the write's transaction, so a rejected write writes nothing — including when the other tenant claimed the domain concurrently. |

The tenancy errors a client sees — `TENANT_REQUIRED`, `TENANCY_NOT_RESOLVED`,
`TENANT_NOT_FOUND` — come from `@basaltkit/tenancy`.

## Hooks & events

None. `tenancy:switched` is emitted by `@basaltkit/tenancy`.

## Which backend?

- **`@basaltkit/tenancy-prisma`** — you already run Postgres/MySQL, or need multiple instances sharing one tenant registry.
- **`@basaltkit/tenancy-sqlite`** — a single node with zero dependencies.

Both implement the identical `TenantSource` contract, so switching is a one-line change. For **database-per-tenant**, pair with [`@basaltkit/prisma`](https://github.com/basaltkit/basalt/tree/main/packages/prisma).

Guides: [Tenancy](/guide/tenancy) · [Database per tenant](/guide/database-per-tenant) · [Persistence](/guide/persistence).
