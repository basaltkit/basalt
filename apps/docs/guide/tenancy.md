# Multi-tenancy

`@basaltkit/tenancy` makes every request tenant-aware. Once the tenant is
resolved, it lives in the context — and cache, storage, queue, logger and your
Prisma client all scope to it automatically.

## Resolvers

Resolvers map an incoming request to a tenant. They run in order; the first that
loads an existing tenant wins.

```ts
import {
  tenancyPlugin,
  MemoryTenantSource,
  headerResolver,
  subdomainResolver,
} from '@basaltkit/tenancy'

tenancyPlugin({
  source: new MemoryTenantSource()
    .add({ id: 'acme', name: 'Acme Inc' })
    .add({ id: 'globex', name: 'Globex' }),
  resolvers: [
    headerResolver(),                          // x-tenant-id: acme
    subdomainResolver({ base: 'basalt.app' }), // acme.basalt.app
  ],
})
```

Other resolvers: `domainResolver()` (custom domains via `source.findByDomain`)
and `routeResolver({ param: 'tenant' })` (`/t/:tenant/...`). Any async
`(request) => tenantId | null` works as a custom resolver.

`MemoryTenantSource` is for development and tests. In production use a durable
`TenantSource` (below) — or implement the contract over your own database.

## Creating tenants

A tenant is just a record in your `TenantSource` — `{ id, ...anything }`. How you
create one depends on the backend.

### In dev — `MemoryTenantSource`

Seed them inline; the `add()` calls chain. Lost on restart, so dev/tests only:

```ts
const tenants = new MemoryTenantSource()
  .add({ id: 'acme', name: 'Acme Inc' })
  .add({ id: 'globex', name: 'Globex', domains: ['app.globex.com'] })

tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'basalt.app' })] })
```

### Durably — `@basaltkit/tenancy-sqlite` / `-prisma`

For production, don't hand-roll the contract — a durable `TenantSource` persists
tenants across a restart. Both ship `save`/`find`/`findByDomain`/`list`/`remove`:

```ts
import { sqliteTenantSource } from '@basaltkit/tenancy-sqlite'   // single node, zero-dep
// import { prismaTenantSource } from '@basaltkit/tenancy-prisma' // Postgres/MySQL

const tenants = sqliteTenantSource('./data/tenants.db')

// save() is an upsert — create or update a tenant. Any extra field round-trips.
await tenants.save({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })

tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'basalt.app' }), domainResolver()],
})
```

`save` replaces the tenant's custom-domain set; a domain already owned by another
tenant is rejected (routing must be unambiguous). See [Persistence](/guide/persistence).

### At sign-up — provision a tenant on demand

A real SaaS creates tenants when a customer signs up. Do it in a service/route:
persist the record, then (for schema- or database-per-tenant) provision its
storage, and optionally seed it — all inside the new tenant's context.

```ts
import { ctx } from '@basaltkit/core'
import { TENANCY } from '@basaltkit/tenancy'
import { provisionTenantSchema, tenantSchema } from '@basaltkit/prisma'

export async function createTenant(input: { id: string; name: string; domains?: string[] }) {
  // 1. persist the tenant (shared-database mode stops here)
  await tenants.save(input)

  // 2. schema-per-tenant only: create its schema, then migrate it
  await provisionTenantSchema(db, tenantSchema(input.id))
  //    …run migrations against tenant_<id> (or the `basalt tenant:migrate` command below)

  // 3. optionally seed starter data *inside* the new tenant
  await app.container.get(TENANCY).run(input.id, async () => {
    await ctx().db.setting.create({ data: { key: 'onboarded', value: 'true' } })
  })

  return input
}
```

Expose it as an admin-guarded route (`POST /tenants`); the `subdomainResolver` /
`domainResolver` route the new tenant's traffic the moment the record exists.

## Reading the tenant

```ts
import { ctx } from '@basaltkit/core'

export async function currentTenant() {
  return ctx().tenant // { id, name, ... } or undefined outside a tenant
}
```

Set `required: true` on the plugin to reject unresolved requests with a
`404 TENANCY_NOT_RESOLVED`.

## Automatic isolation

You don't isolate anything by hand. The same code behaves per tenant:

```ts
await cache.put('config', value)          // key prefixed with tenant:<id>
await storage.disk('uploads').put(path, f) // stored under tenants/<id>/
await SendEmail.dispatch({ userId })       // tenant restored in the worker
logger.info('done')                        // log carries tenantId
```

## Running code in a tenant

Outside a request — in a job, a script, or maintenance — enter a tenant
explicitly:

```ts
import { TENANCY } from '@basaltkit/tenancy'

const tenancy = app.container.get(TENANCY)

await tenancy.run('acme', async () => {
  // ctx().tenant is now Acme; everything scopes to it
})

await tenancy.forEach(async (tenant) => {
  // bulk maintenance across every tenant
}, { concurrency: 5 })
```

## Isolation modes

Your queries stay `ctx().db.user.findMany()` in all three modes — the mode is
configuration, not a rewrite.

**Shared database** (default) — a `tenantId` column, filtered automatically by
the `@basaltkit/prisma` extension:

```ts
const db = new PrismaClient().$extends(tenancyExtension())
prismaPlugin({ client: db })
```

**Schema per tenant** — one database, one PostgreSQL schema per tenant. Each
tenant gets a client whose connection URL carries `?schema=tenant_<id>`, so
Prisma sets the search_path at connect time (reliable, unlike per-request
search_path switching on a shared pool). Bounded by an LRU client pool:

```ts
prismaPlugin({
  schemaPerTenant: {
    url: env.DATABASE_URL,
    createClient: (url) => new PrismaClient({ datasourceUrl: url }),
  },
  max: 25,
})
```

Provision a tenant's schema with `provisionTenantSchema(db, tenantSchema(id))`
and run your migrations against that schema.

**Database per tenant** — a separate database (and client) per tenant, via the
same pool:

```ts
prismaPlugin({ forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }) })
```

## Migrations per tenant

Schema- and database-per-tenant need migrations run for each tenant.
`migrateTenants` orchestrates it — bounded concurrency, provisioning the schema
first (schema mode), and a per-tenant report where one failure never aborts the
rest. Wire it as a `basalt tenant:migrate` command:

```ts
import { tenantMigrateCommand, provisionTenantSchema } from '@basaltkit/prisma'
import { commandsPlugin } from '@basaltkit/cli'

commandsPlugin([
  tenantMigrateCommand({
    tenants: () => tenants.list().then((all) => all.map((t) => t.id)),
    target: {
      mode: 'schema',
      url: env.DATABASE_URL,
      provision: db, // a client with $executeRawUnsafe — CREATE SCHEMA IF NOT EXISTS
    },
  }),
])
```

```bash
basalt tenant:migrate
#  ok   acme (tenant_acme)
#  FAIL globex (tenant_globex) — <error>
#  Done: 1 migrated, 1 failed.
```

The default migrator shells out to `prisma migrate deploy` with each tenant's
scoped connection URL; pass `migrate` to override it.
