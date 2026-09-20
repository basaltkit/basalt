<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/prisma

Basalt's integration with Prisma: connects your application to the database in a multi-tenant way — each customer (tenant) automatically sees only their own data. You need this module when your SaaS application uses Prisma and serves multiple customers with data isolated from each other.

## What this module solves

**Prisma** is an **ORM** (*Object-Relational Mapper*): a library that lets you talk to the database by writing TypeScript code (`db.project.findMany()`) instead of raw SQL. In a **multi-tenant** application (several customers/organizations — the **tenants** — in the same application) a central problem arises: how do you guarantee that customer "acme" never sees customer "globex"'s data?

This module supports the three classic isolation strategies and handles the tedious work for each:

1. **Shared database** — all tenants in the same database, each row with a `tenantId` column. The `tenancyExtension()` extension intercepts **every** query and injects the current tenant's filter (or refuses the query when it cannot scope it): application code cannot forget the `where: { tenantId }` or override it. Pair it with composite foreign keys and RLS for database-level isolation (see *Limits* below).
2. **Schema per tenant** (PostgreSQL) — one database, but each tenant has its own *schema* (a "compartment" with its own tables). The module derives safe schema names, builds connection URLs with the right schema, and creates schemas when needed.
3. **Database per tenant** — maximum isolation: each tenant has its own database. The module manages an **LRU pool** of Prisma clients (keeps only the N most recent ones open, closes the rest) so connections don't explode.

In any mode, `prismaPlugin` puts the right client into each request's context — application code just writes `db<PrismaClient>().project.findMany()` without knowing (or needing to know) which strategy is behind it. There are also tools for **migrations** (applying database structure changes) tenant by tenant, including a ready-to-use CLI command.

## Installation

```bash
pnpm add @basaltkit/prisma
```

Depends on `@basaltkit/core` and `@basaltkit/cli`. Prisma itself is an optional *peer dependency* — install it in your project if you don't already have it:

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
import { createApp } from '@basaltkit/core'
import { prismaPlugin, tenancyExtension } from '@basaltkit/prisma'

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
import { db } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'

// Inside an HTTP handler (the tenant has already been identified by the framework):
const projects = await db<PrismaClient>().project.findMany()
// → SELECT ... WHERE tenantId = '<request's tenant>' — without you writing the filter
```

That's it: reads are filtered by tenant, creates are stamped with the right `tenantId`, and no request ever accidentally touches another tenant's data.

## Usage guide

### Mode 1 — Shared database (`tenancyExtension`)

The extension scopes every model operation it knows, and **refuses** (fails closed) anything it cannot scope:

- **Reads and writes with `where`** (`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`, `updateManyAndReturn`, `delete`, `deleteMany`): the `tenantId` filter is **forced** — even if the code passes `where: { tenantId: 'other' }`, the current tenant's filter wins.
- **Creates** (`create`, `createMany`, `createManyAndReturn`): `tenantId` is stamped onto the data (overriding any value the caller passed).
- **`upsert`**: the `where` is filtered, the `create` branch is stamped, and the `update` branch may not change `tenantId`.
- **Updates cannot move rows between tenants**: setting `tenantId` to another tenant in `update`/`updateMany`/`updateManyAndReturn`/`upsert` data throws `CrossTenantWriteError` (`PRISMA_CROSS_TENANT_WRITE`).
- **Nested relation writes** inside `data` are scoped too: nested `create`/`createMany`/`connectOrCreate.create` are stamped with the tenant, and `connect`, `connectOrCreate.where`, `set`, `disconnect`, `update`, `updateMany`, `upsert`, `delete` and `deleteMany` get the tenant filter — a relation cannot be linked to, or modify, another tenant's row.
- **Raw and unknown operations** inside a tenant context throw: `$queryRaw`, `$executeRaw`, `$queryRawUnsafe`, `$executeRawUnsafe`, `$queryRawTyped`, `$runCommandRaw` (any client-level operation) and MongoDB's `findRaw`/`aggregateRaw` throw `RawQueryInTenantContextError` (`PRISMA_RAW_IN_TENANT`); any other model operation the extension does not know (e.g. one added by a future Prisma release) throws `UnscopedOperationError` (`PRISMA_UNSCOPED_OPERATION`) instead of running unscoped.

```ts
import { PrismaClient } from '@prisma/client'
import { tenancyExtension } from '@basaltkit/prisma'

const prisma = new PrismaClient().$extends(
  tenancyExtension({
    tenantField: 'tenantId',      // column name (default: 'tenantId')
    // onMissingTenant defaults to 'error': a query with no tenant in context
    // throws MissingTenantError instead of running across every tenant.
  }),
)
```

Central/admin code that must read across tenants should use a **separate, explicitly named** client — never put `'bypass'` on the app's main client:

```ts
// Only for trusted central code paths (back-office jobs, migrations, …).
export const adminPrisma = new PrismaClient().$extends(
  tenancyExtension({ onMissingTenant: 'bypass' }),
)
```

Note on `findUnique`/`update`/`delete`: since Prisma 5, the unique `where` accepts extra fields as additional filters — the module injects `tenantId` there, so a row from another tenant simply "isn't found".

**Limits — add database-level isolation.** The extension works on query arguments, so it cannot know which scalar columns are foreign keys: `data: { projectId: '<another tenant's id>' }` is not checked, and an `include`/`select` of a relation follows whatever foreign key is stored. Make foreign keys composite (`@relation(fields: [tenantId, projectId], references: [tenantId, id])` with `@@unique([tenantId, id])` on the target) so the database refuses cross-tenant links, and enable RLS (`rlsPolicySql`) as defense in depth. Relation-write detection is by shape (an object whose keys are all nested-write operations), so a `Json` column whose value looks exactly like `{ create: … }` would be treated as a relation write.

#### Postgres Row-Level Security (`rls: true`)

`rls: true` makes the database enforce the tenant too. Every model operation in tenant scope runs as `$transaction([ set_config('app.tenant_id', <tenant>, true), <operation> ])`, so the policies generated by `rlsPolicySql` filter the rows — even for what the extension cannot see, like an `include` that follows a cross-tenant foreign key.

```ts
import { rlsPolicySql, tenancyExtension, tenantTransaction } from '@basaltkit/prisma'

// once, in a SQL migration: ENABLE + FORCE RLS and a tenant-isolation policy per table
rlsPolicySql({ tables: ['invoices', 'invoice_lines'], tenantColumn: 'tenantId' })

const db = new PrismaClient().$extends(tenancyExtension({ rls: true })) // or { rls: { setting: 'app.tenant_id' } }

// interactive transactions: tenantTransaction sets the tenant on the transaction's connection first
await tenantTransaction(db, async (tx) => {
  const invoice = await tx.invoice.create({ data })
  await tx.invoiceLine.createMany({ data: lines(invoice.id) })
})
```

- **Connect as a role RLS applies to** — superusers and `BYPASSRLS` roles skip policies; the table owner skips them unless `FORCE ROW LEVEL SECURITY` is set (`rlsPolicySql` sets it by default).
- **Costs** — each tenant-scoped operation becomes a short batch transaction (`BEGIN`, `set_config`, query, `COMMIT`): a few extra statements on the same connection (≈ +2 ms p50 measured). The setting is transaction-local and never leaks onto a pooled connection.
- **Transactions you open yourself are not wrapped** (Prisma can't nest them). A plain interactive `db.$transaction(async (tx) => …)` runs without the setting and fails closed (no rows / `42501` on writes) — use `tenantTransaction(db, fn)`, and use `tx` (not the outer `db`) inside it. A batch `db.$transaction([...])` must **lead** with `db.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(tenantId))`.
- **The raw guard stays on**: that exact `set_config` statement, for the tenant already in scope, is the only raw query allowed inside a tenant context; any other still throws `PRISMA_RAW_IN_TENANT`.
- An `onMissingTenant: 'bypass'` client sends no setting, so it sees nothing under RLS — connect central/admin code with its own role.

#### Sweeping every tenant (cross-tenant scan)

A reconciler ([`defineReconciler`](https://github.com/basaltkit/basalt/tree/main/packages/scheduler#definereconcilert-options-reconcileroptionst-reconciler)) has to answer a question no tenant-scoped query can answer: *which rows, anywhere, are still `PROCESSING`?* Under RLS the application role only ever sees one tenant, and the extension refuses unscoped queries — so the sweep cannot be an ordinary query at all.

`crossTenantScanSql` installs one narrow, audited door: a `SECURITY DEFINER` function that returns **identifier columns only**, across every tenant. `crossTenantSweep` pages through it and processes each row back inside its own tenant's scope.

```ts
import { crossTenantScanSql, crossTenantScan, crossTenantSweep } from '@basaltkit/prisma'

// once, in a SQL migration (run it as a role that bypasses the table's RLS)
crossTenantScanSql({
  name: 'stuck_jobs',
  table: 'jobs',
  tenantColumn: 'tenantId',
  columns: ['id'],                                  // identifiers ONLY — never tenant data
  where: `t."status" = 'PROCESSING' AND t."updatedAt" < now() - interval '15 minutes'`,
  role: 'app',                                      // the role the app connects as
  owner: 'app_owner',                               // BYPASSRLS / superuser — see below
  maxRows: 500,
})

// in the reconciler (central code — no tenant in scope)
await crossTenantSweep({
  client: db,
  scanFunction: 'stuck_jobs',
  run: (tenantId, fn) => tenancy.run(tenantId, fn),  // each item under its own tenant
  handle: (item) => RetryJob.dispatch({ jobId: item.id }),
})

// or just the identifiers
const stuck = await crossTenantScan(db, 'stuck_jobs', { limit: 200 })
```

- **It is a deliberate RLS bypass** — inside the function the policies do not apply. That is only safe because of what it returns: identifiers. Never widen it to a column holding tenant data; read the data itself inside `tenancy.run(tenantId, …)` through the scoped client. The generated SQL says so, loudly, in a comment.
- **Hardened by construction** — `SET search_path` is pinned inside the function (a `SECURITY DEFINER` function without one is a privilege-escalation hole), it is `STABLE` / `PARALLEL SAFE`, every identifier is validated and quoted, and `EXECUTE` is revoked from `PUBLIC` and granted only to the roles you name.
- **Owned by a role the policies don't reach** — `rlsPolicySql` sets `FORCE ROW LEVEL SECURITY`, so a function owned by the table owner would be filtered too and return nothing. Give it a `BYPASSRLS` owner (or create it as a superuser).
- **Bounded** — `p_limit` is clamped to `maxRows` in the function itself and `(p_after_tenant, p_after_id)` is an ordered cursor, so a sweep pages instead of pulling millions of rows. `crossTenantSweep` adds `limit` (per page) and `maxItems` (per sweep, default 10 000).
- **Guarded at runtime** — the scan refuses to run inside a tenant context (`PRISMA_CROSS_TENANT_IN_TENANT`: it is central code by definition, which is also why it is *not* exempt from the `PRISMA_RAW_IN_TENANT` guard the internal `set_config` is), and it refuses a deployed function whose returned columns are not a subset of the ones you declared (`PRISMA_CROSS_TENANT_SCAN_SHAPE`) — a function widened after the fact never reaches application code.
- **Without RLS none of this is needed**: a central client (`onMissingTenant: 'bypass'`, or one without the extension) can select the identifiers directly. Pass that query as `scan` and keep the paging, grouping and per-tenant execution:

```ts
await crossTenantSweep({
  scan: ({ limit, after }) => central.job.findMany({
    where: { status: 'PROCESSING', ...(after ? { OR: [{ tenantId: { gt: after.tenantId } }, { tenantId: after.tenantId, id: { gt: after.id } }] } : {}) },
    select: { tenantId: true, id: true },
    orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
    take: limit,
  }),
  handle: (item) => RetryJob.dispatch({ jobId: item.id }),
})
```

### Mode 2 — Schema per tenant (PostgreSQL)

Each tenant has its own schema (`tenant_acme`, `tenant_globex`, …) in the same database. Each tenant's client connects with `?schema=<name>` in the URL — Prisma is what sets the `search_path` on connection (the reliable way to do this):

```ts
import { PrismaClient } from '@prisma/client'
import { createApp } from '@basaltkit/core'
import { prismaPlugin } from '@basaltkit/prisma'

const app = await createApp({
  plugins: [
    prismaPlugin({
      schemaPerTenant: {
        url: process.env.DATABASE_URL!, // base URL; the ?schema= parameter is set per tenant
        createClient: (url) => new PrismaClient({ datasourceUrl: url }),
        prefix: 'tenant_',              // default: 'tenant_'
      },
      destroy: (client) => client.$disconnect(), // default: $disconnect() when the client has one
      max: 10,                                    // max clients open at once
    }),
  ],
}).boot()
```

The schema name is derived with `tenantSchema(tenantId)`, and two different tenant ids never map to the same schema:

- a **canonical** id — lowercase `[a-z0-9]` words joined by single underscores (`acme`, `acme_co`) — is used as-is: `tenant_acme`;
- **any other** id (uppercase, `-`, `.`, `__`, UUIDs, …) gets a readable part plus `__` and a SHA-256-based suffix of the raw id: `Acme-Co` → `tenant_acme_co__<16 hex>`. So `ACME` or `acme-co` can never land in the schema of `acme` or `acme_co`.

Names are at most 63 characters; ids with no letters or digits, over-long canonical ids and ids containing a lone UTF-16 surrogate (which UTF-8 would turn into U+FFFD) throw `InvalidTenantSchemaError`.

> **Upgrading from `@basaltkit/prisma` < 1.8:** earlier versions lowercased and replaced characters (`Acme-Co` → `tenant_acme_co`), which let different ids share a schema. Canonical ids keep their schema name; for any tenant whose id is not canonical, rename its schema once (`ALTER SCHEMA "<old>" RENAME TO "<tenantSchema(id)>"`) after checking that no two tenants shared it.

To create a new tenant's schema:

```ts
import { PrismaClient } from '@prisma/client'
import { provisionTenantSchema, tenantSchema } from '@basaltkit/prisma'

const admin = new PrismaClient() // administrative connection
const schema = tenantSchema('acme')          // 'tenant_acme'
await provisionTenantSchema(admin, schema)   // CREATE SCHEMA IF NOT EXISTS "tenant_acme"
```

### Mode 3 — Database per tenant (`forTenant`)

Maximum isolation: you provide a function that creates the client for a tenant id, and the module manages the pool:

```ts
import { PrismaClient } from '@prisma/client'
import { createApp } from '@basaltkit/core'
import { prismaPlugin } from '@basaltkit/prisma'

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

The pool is **LRU** (*least recently used*): when the limit is exceeded, the tenant client that's gone longest without use is closed (via `destroy`, which defaults to `client.$disconnect()`). Active tenants always reuse the same client, and concurrent first requests for a cold tenant share a single client creation — a burst of requests cannot open duplicate clients.

You can combine `client` (for the central, tenant-less context) with `forTenant`/`schemaPerTenant` (for requests with a tenant) in the same plugin. That is what lets one app serve both worlds:

```ts
prismaPlugin({
  client: prisma,                                    // no tenant → central database
  schemaPerTenant: { url, createClient },            // tenant → ?schema=tenant_<id>
  destroy: (client) => client.$disconnect(),
})

// One handler, both worlds — central on the apex, tenant on a subdomain.
route({ method: 'GET', url: '/users', meta: { tenant: false }, handler: async () =>
  db<PrismaClient>().authUser.findMany(),
})
```

Note the trade-off: without `client`, a tenant route reached with no tenant throws `DB_UNAVAILABLE`; with it, that route would quietly query the **central** database instead. Pair it with `required: true` on `tenancyPlugin` and mark only genuinely central routes with `meta: { tenant: false }` — see [Serving central and tenant routes from one app](https://basaltkit.dev/guide/database-per-tenant#serving-central-and-tenant-routes-from-one-app).

### `db()` — the current context's client

```ts
import { db } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'

const projects = await db<PrismaClient>().project.findMany()
```

Works inside an HTTP request or `tenancy.run()`/workers (the plugin listens to the `tenancy:switched` hook). Outside any context it throws `DbUnavailableError`. The `<PrismaClient>` generic is just for TypeScript — pass your client's type (including the extended type, if you use `$extends`).

### Multi-tenant migrations (`migrateTenants`)

A **migration** applies structural changes (new tables, columns…) to the database. In modes 2 and 3 you have to run it for **every** tenant. `migrateTenants` orchestrates this with limited concurrency, and one tenant failing doesn't block the rest:

```ts
import { PrismaClient } from '@prisma/client'
import { migrateTenants } from '@basaltkit/prisma'

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

A ready-to-use command-line version — register it with `@basaltkit/cli`'s `commandsPlugin`:

```ts
import { createApp } from '@basaltkit/core'
import { commandsPlugin } from '@basaltkit/cli'
import { tenantMigrateCommand } from '@basaltkit/prisma'

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

Running `basalt tenant:migrate` prints a report per tenant (`ok`/`FAIL`) and exits with a non-zero code if any tenant failed — ideal for CI/CD pipelines.

## API reference

### `prismaPlugin(options: PrismaPluginOptions<TClient>)`

Registers the client(s) in the container (`DB`, `DB_POOL`), attaches the client to the context of every HTTP request and every `tenancy.run()`, and on `shutdown` closes the pool and calls `$disconnect()` on the shared client.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `client` | `TClient` | No* | — | Shared mode: one client for everyone (typically with `$extends(tenancyExtension())`). Also used as the client for the tenant-less context in the other modes. |
| `forTenant` | `(tenantId: string) => TClient \| Promise<TClient>` | No* | — | Database-per-tenant mode: client factory. |
| `schemaPerTenant` | `{ url: string; createClient: (url: string) => TClient \| Promise<TClient>; prefix?: string }` | No* | `prefix: 'tenant_'` | Schema-per-tenant mode: base URL + factory from the URL with `?schema=`. |
| `destroy` | `(client: TClient, tenantId: string) => void \| Promise<void>` | No | `client.$disconnect()` when present | Called when a client leaves the pool. |
| `max` | `number` | No | `10` | Max per-tenant clients open at once. |
| `assertMigrated` | `boolean \| { tables?: string[] }` | No | off | At boot, check that the shared `client`'s database has `_prisma_migrations` (and the listed tables, case-sensitive) and fail with `DatabaseNotMigratedError` naming the database and host (never credentials). Catches a wrong `DATABASE_URL` at startup instead of a P2021 on the first request. Needs `client`. |

\* Use at least one of the three: `client`, `forTenant`, or `schemaPerTenant` (`forTenant` takes priority over `schemaPerTenant`).

### `db<T>()`

`db<T = unknown>(): T` — returns the database client for the current context. Throws `DbUnavailableError` (code `DB_UNAVAILABLE`) outside a request/`tenancy.run()` with the plugin configured.

### `tenancyExtension(options?: TenancyExtensionOptions)`

Prisma client extension (`prisma.$extends(...)`) that scopes every query to the context's tenant.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `tenantField` | `string` | No | `'tenantId'` | Name of the column holding the tenant id. |
| `getTenantId` | `() => string \| undefined` | No | reads `ctx().tenant.id` | How to get the current tenant. |
| `onMissingTenant` | `'bypass' \| 'error'` | No | `'error'` | No tenant in context: `'error'` throws `MissingTenantError` (fail closed); `'bypass'` runs without a filter — only on a separate central/admin client, never on the app's main client. |
| `onRawInTenant` | `'allow' \| 'error'` | No | `'error'` | Raw/client-level operations (`$queryRaw`, `$executeRaw`, `$queryRawTyped`, `$runCommandRaw`, `findRaw`, `aggregateRaw`, …) inside a tenant context: `'error'` throws `RawQueryInTenantContextError`; `'allow'` runs them as-is (only for queries you scoped by hand). The one exception is `$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(<current tenant>))`, always allowed. |
| `rls` | `boolean \| { setting?: string }` | No | off | Postgres RLS: run each tenant-scoped operation after `set_config(<setting>, <tenant>, true)` in one batch transaction. `setting` default `'app.tenant_id'`. With `rls` on, the extension is returned in Prisma's function form (still passed to `$extends`). See *Postgres Row-Level Security* above. |

### `tenantTransaction(client, fn, options?)`

`tenantTransaction<C, R>(client: C, fn: (tx) => Promise<R>, options?: TenantTransactionOptions): Promise<R>` — opens an interactive `$transaction`, runs `set_config(<setting>, <tenant>, true)` on its connection first, then `fn(tx)`. Pass the tenant-scoped client: `tx` stays scoped. Throws `MissingTenantError` with no tenant.

| Option | Type | Default | Description |
|---|---|---|---|
| `tenantId` | `string` | `ctx().tenant.id` | Tenant to activate. |
| `setting` | `string` | `'app.tenant_id'` | Postgres setting the policies read. |
| `transaction` | `object` | — | Passed to Prisma's `$transaction` (`isolationLevel`, `maxWait`, `timeout`). |

### RLS helpers

| Export | Signature | Description |
|---|---|---|
| `rlsPolicySql` | `rlsPolicySql(options: RlsPolicyOptions): string` | Idempotent SQL enabling (and by default forcing) RLS plus a tenant-isolation policy per table. Options: `tables`, `tenantColumn` (default `'tenant_id'`), `setting`, `policyName`, `schema`, `force` (default `true`). |
| `setTenantConfigSql` | `setTenantConfigSql(): string` | `select set_config($1, $2, true)`. |
| `tenantConfigParams` | `tenantConfigParams(tenantId: string, setting?: string): [string, string]` | Params for `setTenantConfigSql` (validates the setting name). |
| `DEFAULT_TENANT_SETTING` | `'app.tenant_id'` | Default setting. |

### Cross-tenant scan helpers

| Export | Signature | Description |
|---|---|---|
| `crossTenantScanSql` | `crossTenantScanSql(options: CrossTenantScanSqlOptions): string` | Idempotent SQL for a `SECURITY DEFINER` function returning the identifiers of matching rows across every tenant (a deliberate RLS bypass — identifiers only). |
| `crossTenantScan` | `crossTenantScan(client, name, args?: CrossTenantScanArgs): Promise<CrossTenantScanRow[]>` | Calls that function and returns `{ tenantId, id }` rows. Refuses to run inside a tenant context; refuses columns you did not declare. |
| `crossTenantSweep` | `crossTenantSweep(options: CrossTenantSweepOptions): Promise<CrossTenantSweepResult>` | Pages through the scan and runs `handle` for every row inside its own tenant's context, grouped by tenant. |
| `CROSS_TENANT_ID_COLUMN` / `CROSS_TENANT_ROW_COLUMN` | `'tenant_id'` / `'id'` | The fixed output column names of the generated function. |

`crossTenantScanSql(options)`:

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | — | Name of the generated function. |
| `table` | `string` | — | Table to scan. |
| `tenantColumn` | `string` | `'tenant_id'` | Column holding the tenant id; returned as `tenant_id`. |
| `tenantType` | `string` | `'text'` | SQL type of that column. |
| `columns` | `Array<string \| { name, type? }>` | — | Identifier columns to return (max 4, **never tenant data**). The first is the row identifier: returned as `id`, orders the scan, carries the cursor — so it must be unique within a tenant. |
| `where` | `string` | `true` | The "stuck" predicate; the table is aliased `t`. Migration SQL you write — semicolons, comments and `$` are refused. |
| `schema` | `string` | `'public'` | Schema of the table and the function. |
| `role` | `string \| string[]` | — | Role(s) granted `EXECUTE` (`PUBLIC` is revoked). |
| `owner` | `string` | — | Role the function runs as. Must not be subject to the table's RLS (`BYPASSRLS`/superuser) or the scan returns nothing. |
| `maxRows` | `number` | `1000` | Hard cap on the rows one call may return. |

`crossTenantSweep(options)`:

| Option | Type | Default | Description |
|---|---|---|---|
| `client` | `PrismaClient` | — | Client used for the scan. Required unless `scan` is given. |
| `scanFunction` | `string` | — | Function generated by `crossTenantScanSql`. |
| `schema` / `columns` | `string` / `string[]` | `'public'` / `[]` | Schema of the function; identifier columns besides `tenant_id`/`id`. |
| `scan` | `(page) => rows` | — | Replaces the function call — what a deployment **without** RLS uses (a plain central query ordered by `(tenantId, id)`). |
| `handle` | `(item, tenantId) => void \| Promise<void>` | — | Processes one item, inside its tenant's context. Must be idempotent. |
| `limit` | `number` | `500` | Rows per page. |
| `maxItems` | `number` | `10000` | Cap on the items one sweep processes (`truncated` in the result). |
| `run` | `(tenantId, fn) => Promise<void>` | context only | Enters the tenant. Pass `(id, fn) => tenancy.run(id, fn)` for the real tenant record and the `tenancy:switched` hook. |
| `onError` | `(error, item) => void` | `console.error` | An item's `handle` threw; the sweep continues. |

### `assertMigrated(client, options?)`

`assertMigrated(client, options?: { tables?: string[] }): Promise<void>` — what `prismaPlugin({ assertMigrated })` runs at boot; usable on its own (a readiness probe, a script). Throws `DatabaseNotMigratedError` when `_prisma_migrations` or a listed table is missing, or the check cannot run (driver errors are included with URL credentials masked by `redactCredentials`).

### `applyTenantScope(operation, args, tenantId, field)` (Advanced)

`applyTenantScope(operation: string, args: Record<string, unknown> | undefined, tenantId: string, field: string): Record<string, unknown>` — the pure transformation used by the extension; useful for tests or your own integrations. Throws `UnscopedOperationError` for an operation it cannot scope and `CrossTenantWriteError` when update data changes the tenant field.

### `class TenantClientPool<TClient>` (Advanced)

`new TenantClientPool(options: TenantClientPoolOptions<TClient>)` — LRU pool of per-tenant clients.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `create` | `(tenantId: string) => TClient \| Promise<TClient>` | Yes | — | Creates a tenant's client. |
| `destroy` | `(client: TClient, tenantId: string) => void \| Promise<void>` | No | `client.$disconnect()` when present | Called on eviction. |
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
| `tenantSchema` | `tenantSchema(tenantId: string, options?: { prefix?: string }): string` | Derives a safe, injective PostgreSQL schema identifier (`prefix` default `'tenant_'`; canonical ids verbatim, other ids with a `__<hash>` suffix; max 63 characters). Throws `InvalidTenantSchemaError`. |
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
| `verifyTables` | `boolean` | No | `true` | After migrating, check the tenant's schema actually has tables and report `ok: false` if not. Schema mode only, and only when `provision` can also read (a `PrismaClient` can). |

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
| `configPath` | `string` | No | Prisma's default location | Path to a `prisma.config.ts` (`--config`). Needed when tenant migrations live outside the central `migrations` directory. |
| `env` | `Record<string, string>` | No | — | Extra environment variables for the child process. |

### `tenantMigrateCommand(config: TenantMigrateCommandConfig)`

Returns a `CommandDefinition` (`@basaltkit/cli`) named `tenant:migrate`.

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
| `MissingTenantError` | Code `PRISMA_TENANT_MISSING` — query without a tenant with `onMissingTenant: 'error'` (the default). |
| `RawQueryInTenantContextError` | Code `PRISMA_RAW_IN_TENANT` — raw/client-level operation inside a tenant context. |
| `UnscopedOperationError` | Code `PRISMA_UNSCOPED_OPERATION` — an operation the extension cannot scope, inside a tenant context. |
| `CrossTenantWriteError` | Code `PRISMA_CROSS_TENANT_WRITE` — update data tried to set the tenant field to another tenant. |
| `CrossTenantScanInTenantError` | Code `PRISMA_CROSS_TENANT_IN_TENANT` — a cross-tenant scan/sweep was started inside a tenant context; it is central code. |
| `CrossTenantScanShapeError` | Code `PRISMA_CROSS_TENANT_SCAN_SHAPE` — the deployed scan function returned a column that was not declared as an identifier (or a NULL identifier). |
| `InvalidTenantSchemaError` | Code `PRISMA_INVALID_SCHEMA` — tenant id without a valid schema identifier. |
| `DatabaseNotMigratedError` | Code `PRISMA_NOT_MIGRATED` — `assertMigrated` found no `_prisma_migrations` (or a listed table) in the database it reached. |
| `EmptyTenantSchemaError` | Code `PRISMA_TENANT_SCHEMA_EMPTY` — the migration exited cleanly but produced no tables. |

## Common errors and solutions (FAQ)

**`DB_UNAVAILABLE: No database client in the current context`.**
You called `db()` outside an HTTP request or `tenancy.run()`, or `prismaPlugin` isn't registered. In scripts/jobs, run the code inside `tenancy.run()` (or use your `PrismaClient` directly).

**`PRISMA_TENANT_MISSING` on a query.**
The query ran without a tenant in context (`onMissingTenant` defaults to `'error'`). Identify the tenant beforehand (tenancy plugin / `tenancy.run()`). For deliberate central queries use a separate admin client built with `onMissingTenant: 'bypass'` — do not set it on the main client.

**My reconciler has to find stuck rows in every tenant, but RLS only shows it one.**
That is what the [cross-tenant scan](#sweeping-every-tenant-cross-tenant-scan) is for: `crossTenantScanSql` (a `SECURITY DEFINER` function returning identifiers only) plus `crossTenantSweep`, which processes each identifier inside its own tenant's context. Starting it inside a tenant context throws `PRISMA_CROSS_TENANT_IN_TENANT` — run the sweep as central code. Without RLS you don't need the SQL function at all: pass your own `scan` query.

**I passed `where: { tenantId: 'other' }` and "it didn't work".**
That's expected: the extension forces the current tenant's filter over whatever the code passes — that's the isolation guarantee. For cross-tenant operations use a client without the extension (administrative context).

**Creates fail for missing `tenantId` / or the data "disappears".**
In shared mode, every model queried through the extension needs the `tenantId` column (or whatever name you set in `tenantField`). Rows created outside the right tenant's context become invisible in that tenant's queries.

**`PRISMA_NOT_MIGRATED` at boot.**
`assertMigrated` reached a database without `_prisma_migrations` (or without a table you listed). The message names the database and host it actually reached: if that is not the one you expected, check `DATABASE_URL` (a shell may have exported another project's); otherwise run `prisma migrate deploy`. Projects that use `prisma db push` have no `_prisma_migrations` — don't enable the check there.

**With `rls: true`, a `$transaction(async (tx) => …)` sees no rows / writes fail with `42501`.**
Transactions you open yourself are not wrapped with `set_config`. Use `tenantTransaction(db, fn)`, or run `tx.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(tenantId))` as its first statement.

**Schema-per-tenant: switching schema per request on the same connection doesn't work?**
Correct — switching `search_path` per request on a shared pool isn't reliable with Prisma. That's why this module creates **one client per tenant** with `?schema=` in the URL; `search_path` is set at connection time.

**`PRISMA_INVALID_SCHEMA` for a tenant id.**
The id doesn't produce a valid PostgreSQL identifier (e.g. only symbols, or name over 63 characters with the prefix). Use simple ids (lowercase letters, numbers, `_`) or a shorter `prefix`.

**Too many database connections in per-tenant mode.**
Adjust `max` on `prismaPlugin` (default 10). Evicted clients are closed with `client.$disconnect()` by default; pass `destroy` only if your client needs a different teardown.

**`prismaMigrator` fails with "command not found" or can't find the schema.**
It needs the Prisma CLI available (`pnpm add -D prisma`), and if `schema.prisma` isn't in the usual place, pass `schemaPath`.

**`PRISMA_TENANT_SCHEMA_EMPTY` after a migration that reported success.**
The migration ran and created nothing. `prisma migrate deploy` exits 0 when it finds no migrations to apply, so a missing or empty migrations directory looks like success — this check is what turns it back into a failure. Confirm the directory exists and has at least one migration, and that `prismaMigrator` points at the config that owns it via `configPath`. Generate a first migration with `prisma migrate diff --from-empty --to-schema-datamodel <tenant schema> --script`.

If a tenant legitimately starts with no tables, pass `verifyTables: false`.

**A freshly provisioned tenant has only the `_prisma_migrations` table.**
Its migrations were read from the wrong directory. `migrations.path` is a property of your `prisma.config.ts`, not of the schema file, so `schemaPath` alone points Prisma at the tenant *models* while it keeps applying the *central* migration history. Give the tenants their own config and pass `configPath`:

```ts
// prisma/tenants/prisma.config.ts — paths here resolve against THIS file's
// directory, not the project root.
export default defineConfig({
  schema: 'schema.prisma',
  migrations: { path: 'migrations' },
  datasource: { url: env('DATABASE_URL') },
})
```

```ts
prismaMigrator({ configPath: './prisma/tenants/prisma.config.ts' })
```

A loaded config also makes Prisma skip its usual `.env` loading, so the config must read its URL from the environment — `prismaMigrator` always sets `DATABASE_URL` to the tenant's URL.

## How it connects to other modules

- **`@basaltkit/core`** — provides `createApp`, the container, the hooks, and the request context; this module adds `ctx().db` to `RequestContext`.
- **`@basaltkit/tenancy`** — identifies each request's tenant and emits `tenancy:switched`; without a tenant in context, the extension throws `MissingTenantError` (unless that client was built with `'bypass'`) and the plugin uses the central client.
- **`@basaltkit/cli`** — `tenantMigrateCommand` is a `defineCommand` command registered via `commandsPlugin` and run with the `basalt` binary.
- **`@basaltkit/http` / `@basaltkit/express` / `@basaltkit/fastify` / `@basaltkit/hono`** — the plugin registers an HTTP *enricher* that attaches the client to each request's context, so `db()` works in handlers.
- **`@basaltkit/cache`** — combines `db()` with `cache.remember(...)` to speed up expensive queries, with consistent per-tenant isolation across both modules.
