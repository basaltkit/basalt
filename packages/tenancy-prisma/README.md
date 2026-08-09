# @machize/tenancy-prisma

Prisma-backed implementation of the [`@machize/tenancy`](https://github.com/Zebedeu/machize/tree/main/packages/tenancy) `TenantSource` — the production reference backend for PostgreSQL/MySQL. Bring your own `PrismaClient`; the package ships a reference schema.

`@machize/tenancy` ships an in-memory `MemoryTenantSource` — fine for tests and dev, but it forgets every tenant on restart and can't be shared across instances. This package persists your tenant registry (and their custom domains) in the database you already run. The single-node, zero-dependency counterpart is [`@machize/tenancy-sqlite`](https://github.com/Zebedeu/machize/tree/main/packages/tenancy-sqlite).

## Installation

```bash
pnpm add @machize/tenancy @machize/tenancy-prisma
```

## Schema

The source touches two models. Don't hand-copy them — run **`mach prisma:sync`** (from [`@machize/prisma`](https://github.com/Zebedeu/machize/tree/main/packages/prisma)), which discovers every installed `@machize/*-prisma` package and merges its models into your `prisma/schema.prisma`:

```bash
pnpm mach prisma:sync --push        # add missing models + create the tables
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
  domain   String @id
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
  @@map("tenant_domains")
}
```

Then `prisma generate` and go.

## Usage

Pass your generated client directly — no cast:

```ts
import { tenancyPlugin, subdomainResolver } from '@machize/tenancy'
import { prismaTenantSource } from '@machize/tenancy-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const tenants = prismaTenantSource(prisma)

await tenants.save({ id: 'acme', name: 'Acme Inc', domains: ['app.acme.com'] })

tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'localhost' })],
})
```

Wire the source before its models exist and it **fails fast** with a message naming the missing model and pointing you at `mach prisma:sync` — no cryptic `reading 'upsert' of undefined`.

## The model & API

A tenant is an **open record** (`{ id, ...anything }`), stored in a `Json` column so any per-tenant fields round-trip unchanged. Custom domains (`tenant.domains: string[]`) are normalized into the indexed `TenantDomain` table, so `findByDomain` (used by the domain resolver) is a keyed lookup.

`PrismaTenantSource` implements the full `TenantSource` contract plus writes: `save` (upsert + replace the domain set), `find`, `findByDomain`, `list`, `remove` (cascades domains). **Domains are globally unique** — `save` rejects a domain already owned by a different tenant up front, before any write, so routing stays unambiguous.

## Which backend?

- **`@machize/tenancy-prisma`** — you already run Postgres/MySQL, or need multiple instances sharing one tenant registry.
- **`@machize/tenancy-sqlite`** — a single node with zero dependencies.

Both implement the identical `TenantSource` contract, so switching is a one-line change. For **database-per-tenant**, pair with [`@machize/prisma`](https://github.com/Zebedeu/machize/tree/main/packages/prisma).
