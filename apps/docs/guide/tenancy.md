# Multi-tenancy

`@basaltkit/tenancy` makes every request tenant-aware. Once the tenant is
resolved, it lives in the context — and cache, storage, queue, logger and your
Prisma client all scope to it automatically.

## Resolvers

A **resolver** maps an incoming request to a tenant reference. You pass a list;
they run in order and the first one whose reference loads an **existing** tenant
from the source wins. A reference to an unknown id falls through to the next
resolver, so you can layer them safely.

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

### The four built-in resolvers

```ts
import {
  subdomainResolver,
  domainResolver,
  headerResolver,
  routeResolver,
} from '@basaltkit/tenancy'

// acme.basalt.app → { id: 'acme' }. Ignores 'www', the bare base domain,
// nested subdomains (a.b.basalt.app), and the port.
subdomainResolver({ base: 'basalt.app' })

// app.acme.com → { domain: 'app.acme.com' }, looked up via source.findByDomain.
// Requires the source to implement findByDomain (see below).
domainResolver()

// Reads an HTTP header (default 'x-tenant-id') → { id: <value> }.
headerResolver()                 // x-tenant-id: acme
headerResolver({ header: 'x-org' })

// Reads a route param (default 'tenant') → { id: params.tenant }.
// Matches routes like /t/:tenant/...
routeResolver()                  // /t/acme/...
routeResolver({ param: 'org' })  // /o/:org/...
```

::: warning Don't trust a browser-supplied header in production
`headerResolver` is ideal for development and internal traffic, but a user can
send `x-tenant-id: another-customer` by hand. In production prefer
`subdomainResolver` / `domainResolver` (DNS is under your control), and verify
the authenticated user belongs to the resolved tenant.
:::

### Custom resolvers

A resolver is just a function `(request) => TenantRef | null` (async allowed),
where `request` is the neutral `{ headers?, params?, url? }` shape and a
`TenantRef` is `{ id }` or `{ domain }`. Write your own when the built-ins don't
fit — e.g. deriving the tenant from a JWT claim already on the request:

```ts
import type { TenantResolver } from '@basaltkit/tenancy'

const claimResolver: TenantResolver = (request) => {
  const org = request.headers?.['x-org-claim']
  return typeof org === 'string' ? { id: org } : null
}

tenancyPlugin({ source, resolvers: [claimResolver, subdomainResolver({ base: 'basalt.app' })] })
```

`MemoryTenantSource` is for development and tests. In production use a durable
`TenantSource` (below) — or implement the contract over your own database.

## The TenantSource contract

A tenant is an **open record** — `{ id, ...anything }` — so you can attach any
per-tenant fields (`name`, `plan`, `domains`, settings…) and they round-trip
unchanged. A `TenantSource` is where those records live; the full interface is
small:

```ts
import type { TenantSource } from '@basaltkit/tenancy'

const source: TenantSource = {
  async find(id) { /* SELECT … WHERE id = ? */ return null }, // required
  async findByDomain(domain) { return null }, // optional — needed by domainResolver()
  async list() { return [] },                 // optional — needed by tenancy.forEach()
}
```

You rarely write this by hand — use `MemoryTenantSource` in dev, or a durable
source in production (both shown below). Only implement the interface yourself
when tenants already live in a table you own.

## Custom domains (verified)

`domainResolver()` maps `app.acme.com → { domain }`, then `findByDomain` loads the
tenant. But you must not let a tenant *claim* a domain they don't own. `CustomDomains`
manages that: register a domain (unverified), prove ownership with a DNS TXT record,
and only **verified** domains resolve.

```ts
import { CustomDomains } from '@basaltkit/tenancy'

const domains = new CustomDomains({ store }) // store defaults to in-memory

// 1. Tenant adds their domain → you show them the DNS record to publish
const { dns } = await domains.add('acme', 'app.acme.com')
// dns → { type: 'TXT', host: '_basalt-verify.app.acme.com', value: 'basalt-domain-verify=…' }

// 2. Once they've added it, verify — a real DNS lookup confirms the token
if (await domains.verify('app.acme.com')) { /* live */ }

// 3. Wire verified domains into your source — unverified ones return null
const source: TenantSource = {
  async find(id) { /* … */ },
  async findByDomain(domain) {
    const tenantId = await domains.tenantOf(domain) // null unless verified
    return tenantId ? this.find(tenantId) : null
  },
}
```

`verify()` does a live `TXT` lookup via `node:dns` (injectable for tests). Provide a
durable `DomainStore` (the same shape as `MemoryDomainStore`) to persist domains.
TLS certificate provisioning is infrastructure — issue the cert with your platform
(Cloudflare, Caddy, ACME) once `verify()` returns `true`.

## Creating tenants

How you create a tenant depends on the backend.

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

::: tip Prisma-backed registry
`prismaTenantSource(prisma)` stores the registry in the Postgres/MySQL database
you already run — ideal for multiple instances sharing one tenant list. Add its
two models with `basalt prisma:sync --push`, then pass your generated
`PrismaClient`. Same `save`/`find`/`findByDomain`/`list`/`remove` surface.
:::

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

The resolved tenant lives in the request context — no argument passing. It's the
open record you stored, so any custom field is right there:

```ts
import { ctx } from '@basaltkit/core'

export async function currentTenant() {
  const tenant = ctx().tenant       // undefined outside a tenant context
  return {
    id: tenant?.id ?? null,
    name: tenant?.name ?? null,     // any field you saved round-trips
    plan: tenant?.plan ?? 'free',
  }
}
```

Set `required: true` on the plugin to reject unresolved requests up front with a
`404 TENANCY_NOT_RESOLVED` — misrouted requests fail loudly instead of running
against global data. Keep it `false` for central routes (landing page, sign-up)
and handle the absent tenant in the handler.

You can also read the tenant through the `TENANCY` facade — handy in services
that don't otherwise touch `ctx()`:

```ts
import { TENANCY } from '@basaltkit/tenancy'

const tenancy = app.container.get(TENANCY)
tenancy.current()          // Tenant | undefined — the active context's tenant
await tenancy.find('acme') // Tenant | null — look one up by id, ignoring context
```

## Automatic isolation

You don't isolate anything by hand. The same code behaves per tenant:

```ts
await cache.put('config', value)          // key prefixed with tenant:<id>
await storage.disk('uploads').put(path, f) // stored under tenants/<id>/
await SendEmail.dispatch({ userId })       // tenant restored in the worker
logger.info('done')                        // log carries tenantId
```

## Running code in a tenant

Outside a request — in a job, a script, or maintenance — there's no resolver, so
you enter a tenant explicitly. `run()` sets `ctx().tenant`, emits
`tenancy:switched` (which re-attaches the tenant's cache, storage, db client…),
and restores the surrounding context afterwards:

```ts
import { TENANCY } from '@basaltkit/tenancy'
import { ctx } from '@basaltkit/core'

const tenancy = app.container.get(TENANCY)

// Pass an id (loaded from the source; throws TenantNotFoundError if unknown)
// or a Tenant object you already have.
const total = await tenancy.run('acme', async () => {
  return ctx().db.invoice.count() // scoped to Acme
})

// Bulk maintenance: visits every tenant, each in its own context, with bounded
// concurrency (default 5). Requires source.list().
await tenancy.forEach(async (tenant) => {
  await tenancy.run(tenant, async () => {
    // …per-tenant work, fully isolated…
  })
}, { concurrency: 5 })
```

React to context switches anywhere with the hook:

```ts
app.hooks.on('tenancy:switched', ({ tenant }) => {
  logger.info(`working for tenant ${tenant.id}`)
})
```

## Isolation modes

`@basaltkit/prisma` implements three isolation strategies. Your query code stays
`db<PrismaClient>().user.findMany()` in all three — the mode is `prismaPlugin`
configuration, not a rewrite. Pick one:

| Mode | How | Isolation | When |
| --- | --- | --- | --- |
| Shared database | one client, `tenancyExtension()` adds a `tenantId` filter | logical | most apps; cheapest to run |
| Schema per tenant | one database, one PostgreSQL schema per tenant | strong | isolation without N databases |
| Database per tenant | a separate database (+ client) per tenant | strongest | compliance, per-tenant backups |

**Shared database** (default) — one client with a `tenantId` column on each
model. The extension forces the current tenant's filter onto every read, and
stamps it onto every create — code can't forget or override it:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, tenancyExtension } from '@basaltkit/prisma'

const db = new PrismaClient().$extends(
  tenancyExtension({
    tenantField: 'tenantId',   // column name (default 'tenantId')
    onMissingTenant: 'bypass',  // no tenant in context → run unfiltered (central/admin).
                                // 'error' throws instead — strict isolation.
  }),
)

prismaPlugin({ client: db })
```

**Schema per tenant** — one database, one PostgreSQL schema per tenant. Each
tenant gets a client whose connection URL carries `?schema=tenant_<id>`, so
Prisma sets the `search_path` at connect time (reliable, unlike per-request
`search_path` switching on a shared pool). Clients are held in a bounded LRU
pool:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, provisionTenantSchema, tenantSchema } from '@basaltkit/prisma'

prismaPlugin({
  schemaPerTenant: {
    url: env.DATABASE_URL,
    createClient: (url) => new PrismaClient({ datasourceUrl: url }),
    prefix: 'tenant_',                          // schema = tenant_<id> (default)
  },
  destroy: (client) => client.$disconnect(),    // close a client evicted from the pool
  max: 25,                                       // most-recently-used clients kept open (default 10)
})

// Provision a new tenant's schema (an admin connection with $executeRawUnsafe):
const admin = new PrismaClient()
await provisionTenantSchema(admin, tenantSchema('acme')) // CREATE SCHEMA IF NOT EXISTS "tenant_acme"
```

**Database per tenant** — a separate database (and client) per tenant, via the
same LRU pool. Give it a factory keyed by tenant id:

```ts
prismaPlugin({
  forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }),
  destroy: (client) => client.$disconnect(),
  max: 20,
})
```

In every mode the plugin attaches the right client to the context on each HTTP
request and inside `tenancy.run()` — you read it with `db<PrismaClient>()`, which
throws `DB_UNAVAILABLE` outside a tenant context. See
[Database-per-tenant](/guide/database-per-tenant) for the full pooled recipe.

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
