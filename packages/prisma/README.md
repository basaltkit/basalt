# @machize/prisma

Machize's integration with Prisma: connects your application to the database in a multi-tenant way — each customer (tenant) automatically sees only their own data. You need this module when your SaaS application uses Prisma and serves multiple customers with data isolated from each other.

## What this module solves

**Prisma** is an **ORM** (*Object-Relational Mapper*): a library that lets you talk to the database by writing TypeScript code (`db.project.findMany()`) instead of raw SQL. In a **multi-tenant** application (several customers/organizations — the **tenants** — in the same application) a central problem arises: how do you guarantee that customer "acme" never sees customer "globex"'s data?

This module supports the three classic isolation strategies and handles the tedious work for each:

1. **Shared database** — all tenants in the same database, each row with a `tenantId` column. The `tenancyExtension()` extension intercepts **every** query and injects the current tenant's filter: it's impossible for application code to forget the `where: { tenantId }` or try to bypass it.
2. **Schema per tenant** (PostgreSQL) — one database, but each tenant has its own *schema* (a "compartment" with its own tables). The module derives safe schema names, builds connection URLs with the right schema, and creates schemas when needed.
3. **Database per tenant** — maximum isolation: each tenant has its own database. The module manages an **LRU pool** of Prisma clients (keeps only the N most recent ones open, closes the rest) so connections don't explode.

In any mode, `prismaPlugin` puts the right client into each request's context — application code just writes `db<PrismaClient>().project.findMany()` without knowing (or needing to know) which strategy is behind it. There are also tools for **migrations** (applying database structure changes) tenant by tenant, including a ready-to-use CLI command.

## Installation

```bash
pnpm add @machize/prisma
```

Depends on `@machize/core` and `@machize/cli`. Prisma itself is an optional *peer dependency* — install it in your project if you don't already have it:

```bash
pnpm add @prisma/client   # requires version >= 5.0.0
pnpm add -D prisma
```

## Get started in 5 minutes

The most common path: shared database with a `tenantId` column.

1. **Add the `tenantId` column** to the models in your `schema.prisma`:

```prisma
model Project {
  id       String @id @default(cuid())
  name     String
  tenantId String   // the column that isolates tenants

  @@index([tenantId])
}
```

2. **Create the Prisma client with the tenancy extension** and register the plugin:

```ts
import { PrismaClient } from '@prisma/client'
import { createApp } from '@machize/core'
import { prismaPlugin, tenancyExtension } from '@machize/prisma'

// The shared client: every query is filtered by the current context's tenant
const prisma = new PrismaClient().$extends(tenancyExtension())

const app = await createApp({
  plugins: [
    prismaPlugin({ client: prisma }),
    // ...your other plugins (http, tenancy, etc.)
  ],
}).boot()
```

3. **Use `db()` anywhere in a request's code** — the client already comes from the context:

```ts
import { db } from '@machize/prisma'
import type { PrismaClient } from '@prisma/client'

// Inside an HTTP handler (the tenant has already been identified by the framework):
const projects = await db<PrismaClient>().project.findMany()
// → SELECT ... WHERE tenantId = '<request's tenant>' — without you writing the filter
```

That's it: reads are filtered by tenant, creates are stamped with the right `tenantId`, and no request ever accidentally touches another tenant's data.

## Usage guide

### Mode 1 — Shared database (`tenancyExtension`)

The extension covers every operation on every model:

- **Reads and writes with `where`** (`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`, `delete`, `deleteMany`): the `tenantId` filter is **forced** — even if the code passes `where: { tenantId: 'other' }`, the current tenant's filter wins.
- **Creates** (`create`, `createMany`, `createManyAndReturn`): `tenantId` is stamped onto the data.
- **`upsert`**: the `where` is filtered and the `create` branch is stamped; the `update` branch is left untouched.

```ts
import { PrismaClient } from '@prisma/client'
import { tenancyExtension } from '@machize/prisma'

const prisma = new PrismaClient().$extends(
  tenancyExtension({
    tenantField: 'tenantId',      // column name (default: 'tenantId')
    onMissingTenant: 'bypass',    // no tenant in context: 'bypass' (default) runs without a filter
                                  // — useful for administrative/central context;
                                  // 'error' throws MissingTenantError — strict isolation
  }),
)
```

Note on `findUnique`/`update`/`delete`: since Prisma 5, the unique `where` accepts extra fields as additional filters — the module injects `tenantId` there, so a row from another tenant simply "isn't found".

### Mode 2 — Schema per tenant (PostgreSQL)

Each tenant has its own schema (`tenant_acme`, `tenant_globex`, …) in the same database. Each tenant's client connects with `?schema=<name>` in the URL — Prisma is what sets the `search_path` on connection (the reliable way to do this):

```ts
import { PrismaClient } from '@prisma/client'
import { createApp } from '@machize/core'
import { prismaPlugin } from '@machize/prisma'

const app = await createApp({
  plugins: [
    prismaPlugin({
      schemaPerTenant: {
        url: process.env.DATABASE_URL!, // base URL; the ?schema= parameter is set per tenant
        createClient: (url) => new PrismaClient({ datasourceUrl: url }),
        prefix: 'tenant_',              // default: 'tenant_'
      },
      destroy: (client) => client.$disconnect(), // closes clients when they leave the pool
      max: 10,                                    // max clients open at once
    }),
  ],
}).boot()
```

The schema name is derived with `tenantSchema(tenantId)`: lowercase, `[a-z0-9_]` only, max 63 characters — invalid ids throw `InvalidTenantSchemaError`. To create a new tenant's schema:

```ts
import { PrismaClient } from '@prisma/client'
import { provisionTenantSchema, tenantSchema } from '@machize/prisma'

const admin = new PrismaClient() // administrative connection
const schema = tenantSchema('acme')          // 'tenant_acme'
await provisionTenantSchema(admin, schema)   // CREATE SCHEMA IF NOT EXISTS "tenant_acme"
```

### Mode 3 — Database per tenant (`forTenant`)

Maximum isolation: you provide a function that creates the client for a tenant id, and the module manages the pool:

```ts
import { PrismaClient } from '@prisma/client'
import { createApp } from '@machize/core'
import { prismaPlugin } from '@machize/prisma'

const app = await createApp({
  plugins: [
    prismaPlugin({
      forTenant: (tenantId) =>
        new PrismaClient({ datasourceUrl: databaseUrlFor(tenantId) }),
      destroy: (client) => client.$disconnect(),
      max: 10, // only the 10 most recently active tenants keep an open client
    }),
  ],
}).boot()
```

The pool is **LRU** (*least recently used*): when the limit is exceeded, the tenant client that's gone longest without use is closed (via `destroy`). Active tenants always reuse the same client.

You can combine `client` (for the central, tenant-less context) with `forTenant`/`schemaPerTenant` (for requests with a tenant) in the same plugin.

### `db()` — the current context's client

```ts
import { db } from '@machize/prisma'
import type { PrismaClient } from '@prisma/client'

const projects = await db<PrismaClient>().project.findMany()
```

Works inside an HTTP request or `tenancy.run()`/workers (the plugin listens to the `tenancy:switched` hook). Outside any context it throws `DbUnavailableError`. The `<PrismaClient>` generic is just for TypeScript — pass your client's type (including the extended type, if you use `$extends`).

### Multi-tenant migrations (`migrateTenants`)

A **migration** applies structural changes (new tables, columns…) to the database. In modes 2 and 3 you have to run it for **every** tenant. `migrateTenants` orchestrates this with limited concurrency, and one tenant failing doesn't block the rest:

```ts
import { PrismaClient } from '@prisma/client'
import { migrateTenants } from '@machize/prisma'

const admin = new PrismaClient()

const results = await migrateTenants({
  tenants: ['acme', 'globex', 'initech'],
  target: {
    mode: 'schema',                  // or { mode: 'database', urlFor: (id) => url }
    url: process.env.DATABASE_URL!,
    provision: admin,                // creates the schema before migrating, if it doesn't exist
  },
  concurrency: 5,                    // default: 5 tenants in parallel
  onResult: (r) => console.log(r.tenantId, r.ok ? 'ok' : `FAILED: ${r.error}`),
})

const failed = results.filter((r) => !r.ok)
```

By default each tenant is migrated with `prismaMigrator()`, which runs `npx prisma migrate deploy` with the tenant's URL as `DATABASE_URL` (requires the Prisma CLI to be installed).

### `tenant:migrate` CLI command

A ready-to-use command-line version — register it with `@machize/cli`'s `commandsPlugin`:

```ts
import { createApp } from '@machize/core'
import { commandsPlugin } from '@machize/cli'
import { tenantMigrateCommand } from '@machize/prisma'

const app = createApp({
  plugins: [
    commandsPlugin([
      tenantMigrateCommand({
        tenants: async () => listTenantIds(), // fetch the ids from wherever you like
        target: { mode: 'schema', url: process.env.DATABASE_URL! },
      }),
    ]),
  ],
})
```

Running `mach tenant:migrate` prints a report per tenant (`ok`/`FAIL`) and exits with a non-zero code if any tenant failed — ideal for CI/CD pipelines.

## API reference

### `prismaPlugin(options: PrismaPluginOptions<TClient>)`

Registers the client(s) in the container (`DB`, `DB_POOL`), attaches the client to the context of every HTTP request and every `tenancy.run()`, and on `shutdown` closes the pool and calls `$disconnect()` on the shared client.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `client` | `TClient` | No* | — | Shared mode: one client for everyone (typically with `$extends(tenancyExtension())`). Also used as the client for the tenant-less context in the other modes. |
| `forTenant` | `(tenantId: string) => TClient \| Promise<TClient>` | No* | — | Database-per-tenant mode: client factory. |
| `schemaPerTenant` | `{ url: string; createClient: (url: string) => TClient \| Promise<TClient>; prefix?: string }` | No* | `prefix: 'tenant_'` | Schema-per-tenant mode: base URL + factory from the URL with `?schema=`. |
| `destroy` | `(client: TClient, tenantId: string) => void \| Promise<void>` | No | — | Called when a client leaves the pool (e.g. `client.$disconnect()`). |
| `max` | `number` | No | `10` | Max per-tenant clients open at once. |

\* Use at least one of the three: `client`, `forTenant`, or `schemaPerTenant` (`forTenant` takes priority over `schemaPerTenant`).

### `db<T>()`

`db<T = unknown>(): T` — returns the database client for the current context. Throws `DbUnavailableError` (code `DB_UNAVAILABLE`) outside a request/`tenancy.run()` with the plugin configured.

### `tenancyExtension(options?: TenancyExtensionOptions)`

Prisma client extension (`prisma.$extends(...)`) that scopes every query to the context's tenant.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `tenantField` | `string` | No | `'tenantId'` | Name of the column holding the tenant id. |
| `getTenantId` | `() => string \| undefined` | No | reads `ctx().tenant.id` | How to get the current tenant. |
| `onMissingTenant` | `'bypass' \| 'error'` | No | `'bypass'` | No tenant in context: `'bypass'` runs without a filter (central/admin context); `'error'` throws `MissingTenantError`. |

### `applyTenantScope(operation, args, tenantId, field)` (Advanced)

`applyTenantScope(operation: string, args: Record<string, unknown> | undefined, tenantId: string, field: string): Record<string, unknown>` — the pure transformation used by the extension; useful for tests or your own integrations.

### `class TenantClientPool<TClient>` (Advanced)

`new TenantClientPool(options: TenantClientPoolOptions<TClient>)` — LRU pool of per-tenant clients.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `create` | `(tenantId: string) => TClient \| Promise<TClient>` | Yes | — | Creates a tenant's client. |
| `destroy` | `(client: TClient, tenantId: string) => void \| Promise<void>` | No | — | Called on eviction. |
| `max` | `number` | No | `10` | Max clients open (minimum 1). |

| Member | Signature | Description |
|---|---|---|
| `get` | `get(tenantId: string): Promise<TClient>` | Returns/creates the tenant's client; promotes it to most-recently-used; evicts the oldest above `max`. |
| `has` | `has(tenantId: string): boolean` | Does the tenant have a client in the pool? |
| `size` | `get size(): number` | Number of open clients. |
| `destroyAll` | `destroyAll(): Promise<void>` | Closes all clients. |

### Schema utilities

| Export | Signature | Description |
|---|---|---|
| `tenantSchema` | `tenantSchema(tenantId: string, options?: { prefix?: string }): string` | Derives a safe PostgreSQL schema identifier (`prefix` default `'tenant_'`; lowercase, `[a-z0-9_]`, max 63 characters). Throws `InvalidTenantSchemaError`. |
| `schemaUrl` | `schemaUrl(baseUrl: string, schema: string): string` | Returns the connection URL with the `?schema=` parameter set. |
| `provisionTenantSchema` | `provisionTenantSchema(client: SchemaProvisioner, schema: string): Promise<void>` | Runs `CREATE SCHEMA IF NOT EXISTS` (name validated before interpolating). |
| `SchemaProvisioner` | `{ $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> }` | Interface satisfied by a `PrismaClient`. |

### `migrateTenants(options: MigrateTenantsOptions)`

Returns `Promise<TenantMigrationResult[]>` — one result per tenant, in the same order.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `tenants` | `string[]` | Yes | — | Ids of the tenants to migrate. |
| `target` | `MigrateTarget` | Yes | — | How to derive each tenant's target (see below). |
| `migrate` | `MigrateFn` | No | `prismaMigrator()` | Runs a tenant's migration. |
| `concurrency` | `number` | No | `5` | Max tenants migrated in parallel. |
| `onResult` | `(result: TenantMigrationResult) => void` | No | — | Called as each tenant finishes. |

`MigrateTarget` is one of two shapes:

- `{ mode: 'schema', url: string, prefix?: string, provision?: SchemaProvisioner }` — schema per tenant; with `provision`, creates the schema before migrating.
- `{ mode: 'database', urlFor: (tenantId: string) => string }` — database per tenant.

`TenantMigrationResult`: `{ tenantId: string; url: string; schema?: string; ok: boolean; error?: string }`.

`MigrateFn`: `(info: { tenantId: string; url: string; schema?: string }) => Promise<void>`.

### `prismaMigrator(options?: PrismaMigratorOptions)`

Default migrator: runs `npx prisma migrate deploy` in a child process, with the tenant's URL as `DATABASE_URL`.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `schemaPath` | `string` | No | Prisma's default location | Path to `schema.prisma` (`--schema`). |
| `env` | `Record<string, string>` | No | — | Extra environment variables for the child process. |

### `tenantMigrateCommand(config: TenantMigrateCommandConfig)`

Returns a `CommandDefinition` (`@machize/cli`) named `tenant:migrate`.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `tenants` | `() => string[] \| Promise<string[]>` | Yes | — | Resolves the ids to migrate. |
| `target` | `MigrateTarget` | Yes | — | Migration target. |
| `migrate` | `MigrateFn` | No | `prismaMigrator()` | Alternative migrator. |
| `concurrency` | `number` | No | `5` | Parallelism. |

### Tokens and errors

| Export | Description |
|---|---|
| `DB` | Token for the shared client in the container. (Advanced) |
| `DB_POOL` | Token for the `TenantClientPool` in the container. (Advanced) |
| `DbUnavailableError` | Code `DB_UNAVAILABLE` — `db()` outside context. |
| `MissingTenantError` | Code `PRISMA_TENANT_MISSING` — query without a tenant with `onMissingTenant: 'error'`. |
| `InvalidTenantSchemaError` | Code `PRISMA_INVALID_SCHEMA` — tenant id without a valid schema identifier. |

## Common errors and solutions (FAQ)

**`DB_UNAVAILABLE: No database client in the current context`.**
You called `db()` outside an HTTP request or `tenancy.run()`, or `prismaPlugin` isn't registered. In scripts/jobs, run the code inside `tenancy.run()` (or use your `PrismaClient` directly).

**`PRISMA_TENANT_MISSING` on a query.**
You configured `onMissingTenant: 'error'` and the query ran without a tenant in context. Either identify the tenant beforehand (tenancy plugin / `tenancy.run()`), or use `'bypass'` to allow central queries without a filter.

**I passed `where: { tenantId: 'other' }` and "it didn't work".**
That's expected: the extension forces the current tenant's filter over whatever the code passes — that's the isolation guarantee. For cross-tenant operations use a client without the extension (administrative context).

**Creates fail for missing `tenantId` / or the data "disappears".**
In shared mode, every model queried through the extension needs the `tenantId` column (or whatever name you set in `tenantField`). Rows created outside the right tenant's context become invisible in that tenant's queries.

**Schema-per-tenant: switching schema per request on the same connection doesn't work?**
Correct — switching `search_path` per request on a shared pool isn't reliable with Prisma. That's why this module creates **one client per tenant** with `?schema=` in the URL; `search_path` is set at connection time.

**`PRISMA_INVALID_SCHEMA` for a tenant id.**
The id doesn't produce a valid PostgreSQL identifier (e.g. only symbols, or name over 63 characters with the prefix). Use simple ids (lowercase letters, numbers, `_`) or a shorter `prefix`.

**Too many database connections in per-tenant mode.**
Adjust `max` on `prismaPlugin` (default 10) and make sure you pass `destroy: (client) => client.$disconnect()` — without it, clients evicted from the pool keep their connection open.

**`prismaMigrator` fails with "command not found" or can't find the schema.**
It needs the Prisma CLI available (`pnpm add -D prisma`), and if `schema.prisma` isn't in the usual place, pass `schemaPath`.

## How it connects to other modules

- **`@machize/core`** — provides `createApp`, the container, the hooks, and the request context; this module adds `ctx().db` to `RequestContext`.
- **`@machize/tenancy`** — identifies each request's tenant and emits `tenancy:switched`; without a tenant in context, the extension bypasses (or throws, depending on configuration) and the plugin uses the central client.
- **`@machize/cli`** — `tenantMigrateCommand` is a `defineCommand` command registered via `commandsPlugin` and run with the `mach` binary.
- **`@machize/http` / `@machize/express` / `@machize/fastify` / `@machize/hono`** — the plugin registers an HTTP *enricher* that attaches the client to each request's context, so `db()` works in handlers.
- **`@machize/cache`** — combines `db()` with `cache.remember(...)` to speed up expensive queries, with consistent per-tenant isolation across both modules.
