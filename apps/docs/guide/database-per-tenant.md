# Database-per-tenant

The strongest tenant isolation is **physical**: each tenant's data lives in its
own database (or its own PostgreSQL schema), so one tenant can never read
another's rows — the boundary is the connection, not a `WHERE tenant_id = ?` you
have to remember on every query. `@basaltkit/prisma` gives you a per-tenant client
pool, and the durable [`*-prisma` stores](/guide/persistence) drop on top of it,
so **every** stateful domain — auth, permissions, comments, audit, the lot —
becomes tenant-isolated for free.

[[toc]]

## Three isolation models

| Model | How | Isolation | When |
| --- | --- | --- | --- |
| Shared DB, row scoping | one client, `tenancyExtension()` adds `tenant_id` filters | logical | most apps; cheapest to run |
| **Schema-per-tenant** | one database, one PostgreSQL schema per tenant | strong | isolation without N databases — **PostgreSQL only**, see [compatibility](#which-strategy-works-on-which-database) |
| **Database-per-tenant** | a separate database per tenant | strongest | compliance, noisy-neighbor, per-tenant backups |

`prismaPlugin` supports all three. This guide covers the latter two — where the
per-tenant *client* is the isolation boundary — and how the durable stores ride
on it.

## Which strategy works on which database

Basalt is database-agnostic where the strategy allows it, and honest where it
does not. Two of the three isolation models work on any Prisma connector; the
third is a PostgreSQL feature and is not abstracted away.

| Strategy | PostgreSQL | MySQL / MariaDB | SQLite | Use instead |
| --- | :---: | :---: | :---: | --- |
| **Shared DB + `tenant_id`** | ✅ | ✅ | ✅ | — the default, and fully portable |
| **Database-per-tenant** | ✅ | ✅ | ✅ (one file per tenant) | — you supply `urlFor()`, so any connector works |
| **Schema-per-tenant** | ✅ | ❌ | ❌ | **`mode: 'database'`** |
| **Row-Level Security** (defence in depth) | ✅ | ❌ | ❌ | the `tenant_id` scoping alone, which is already fail-closed |

### Why schema-per-tenant is PostgreSQL-only

It rests on two things PostgreSQL has and the others do not: a **schema** as a
namespace *inside* a database, and a connection whose `search_path` selects it.
Basalt uses Prisma's `?schema=` parameter for the second and
`CREATE SCHEMA IF NOT EXISTS` for the first.

In MySQL a "schema" **is** a database — the words are synonyms — so there is
nothing to namespace *within* a database. SQLite has no equivalent at all.

We deliberately do **not** paper over this. An abstraction that quietly turned
`mode: 'schema'` into a separate database on MySQL would be doing
database-per-tenant under a name that says otherwise: different backup story,
different connection limits, different migration cost. Choosing that should be
your decision, written in your config, not a translation you never saw.

**On MySQL, pick `mode: 'database'`.** It gives you stronger isolation than
schema-per-tenant anyway, and it is fully supported.

### Why RLS is PostgreSQL-only

`CREATE POLICY`, `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and
`current_setting()` have no MySQL or SQLite equivalent. RLS is defence in depth
*under* the `tenant_id` scoping, never a replacement for it — so an app without
it is not unprotected, it simply has one layer instead of two.

## The per-tenant client pool

Give `prismaPlugin` a factory and it maintains a bounded LRU pool of clients,
one per tenant, building them on demand:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin } from '@basaltkit/prisma'

// database-per-tenant: a client per tenant connection string
prismaPlugin({
  forTenant: (tenantId) => new PrismaClient({ datasourceUrl: urlFor(tenantId) }),
  destroy: (client) => client.$disconnect(),
  max: 20, // most-recently-used clients kept open
})
```

Schema-per-tenant is one database with a schema per tenant — pass the base URL
and a client factory, and Basalt sets `?schema=tenant_<id>` per tenant so Prisma
switches the `search_path` at connect time (reliable, unlike per-request
switching on a shared pool):

```ts
prismaPlugin({
  schemaPerTenant: {
    url: process.env.DATABASE_URL!,
    createClient: (url) => new PrismaClient({ datasourceUrl: url }),
    prefix: 'tenant_', // schema name = tenant_<id>
  },
  destroy: (client) => client.$disconnect(),
})
```

In both cases the plugin attaches the right client to the request context — on
HTTP requests (from the resolved tenant) and inside `tenancy.run()` (workers,
jobs). You read it with `db()`:

```ts
import { db } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'

route({ method: 'GET', url: '/projects', handler: () =>
  db<PrismaClient>().project.findMany(), // this tenant's database, automatically
})
```

`db()` throws `DB_UNAVAILABLE` outside a tenant context, so an unscoped operation
fails loudly instead of silently touching the wrong data.

## Provisioning a new tenant

Before a tenant's first request, its storage has to exist. Declare it once as
`onProvision` on `tenancyPlugin` and every creation path runs it — see
[At sign-up](/guide/tenancy#at-sign-up-—-provision-a-tenant-on-demand):

```ts
tenancyPlugin({
  source, resolvers,
  async onProvision(tenant) {
    const admin = new PrismaClient()
    await provisionTenantSchema(admin, tenantSchema(tenant.id))
    await migrateTenants({
      tenants: [tenant.id],
      target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
    })
  },
})

await tenancy.create({ id, name })   // persists → provisions → emits tenancy:created
```

The same steps written by hand, when you want them outside the plugin — for
**schema-per-tenant** that's `provisionTenantSchema` + a migration; for
**database-per-tenant** you create the database out of band (your
infra/provider), then migrate it the same way:

```ts
import { PrismaClient } from '@prisma/client'
import { provisionTenantSchema, tenantSchema, migrateTenants } from '@basaltkit/prisma'

export async function provisionTenant(id: string, name: string) {
  await tenants.save({ id, name })                 // 1. register in the TenantSource

  // 2. schema-per-tenant: create the schema on an admin connection
  const admin = new PrismaClient()
  await provisionTenantSchema(admin, tenantSchema(id)) // CREATE SCHEMA IF NOT EXISTS "tenant_<id>"

  // 3. bring its structure up to date (single-tenant slice of the migrator)
  await migrateTenants({
    tenants: [id],
    target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
  })
}
```

Once the record exists, `subdomainResolver` / `domainResolver` route the new
tenant's traffic **immediately**, and the pool builds its client on first use.
That is precisely why provisioning should not be a step you remember to call:
between `save()` and the migration there is a window in which the tenant is
reachable and broken. `tenancy.create()` closes it by doing both.

## Durable stores, one per tenant

Here's the payoff. The [`*-prisma` stores](/guide/persistence) take a
`PrismaClient`. Instead of one fixed client, give them a tiny **proxy that
resolves `db()` at call time** — so every store operation runs against whichever
tenant's database is active on the current request:

```ts
import { db } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { prismaAccessStore } from '@basaltkit/permissions-prisma'
import { prismaCommentsStore } from '@basaltkit/comments-prisma'

// Every model access resolves to the ACTIVE tenant's client. Build once.
const tenantDb = new Proxy({} as PrismaClient, {
  get: (_t, model: string) => (db() as unknown as Record<string, unknown>)[model],
})

const auth = prismaAuthStores(tenantDb)
const access = prismaAccessStore(tenantDb)
const comments = prismaCommentsStore(tenantDb)
```

Now wire them into their plugins as usual. `tenancyPlugin` resolves the tenant;
`prismaPlugin({ forTenant })` pools a client per tenant and puts it in context —
so the stores above land in the right database on every request:

```ts
createApp({
  plugins: [
    tenancyPlugin({
      source: tenants, // your durable TenantSource (sqlite/prisma) — see Multi-tenancy
      resolvers: [subdomainResolver({ base: 'myapp.com' })],
    }),
    prismaPlugin({
      forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }),
      destroy: (client) => client.$disconnect(),
      max: 20,
    }),
    authPlugin({ secret, users: auth.users, sessions: auth.sessions,
                 refreshTokens: auth.refreshTokens, tokens: auth.tokens, mfa: auth.mfa }),
    apiKeysPlugin({ store: auth.apiKeys, users: auth.users }),
    permissionsPlugin({ store: access.store }),
    commentsPlugin({ store: comments.store }),
  ],
})
```

A login on `acme.myapp.com` reads and writes users in **acme's** database; the
same code on `globex.myapp.com` hits globex's. No store carries a `tenant_id`
column, no query needs a tenant filter — the isolation is the connection. Because
`db()` throws outside a tenant context, an operation that isn't scoped to a
tenant fails loudly instead of silently touching the wrong data.

::: tip Shared-database mode is simpler
If you don't need physical isolation, pass a single `client` (extended with
`tenancyExtension()`) to `prismaPlugin` and to the store factories directly — no
proxy. Row-level scoping keeps tenants apart with one database. Reach for
database/schema-per-tenant when the isolation guarantee has to be physical.
:::

## Migrating every tenant

N databases means a schema change has to reach all of them. `migrateTenants`
runs a migration across every tenant with bounded concurrency, reporting each
result without letting one failure abort the rest. Pick the target that matches
your mode:

```ts
import { PrismaClient } from '@prisma/client'
import { migrateTenants } from '@basaltkit/prisma'

const ids = (await tenants.list()).map((t) => t.id)

// Database-per-tenant: derive each tenant's connection URL.
const results = await migrateTenants({
  tenants: ids,
  target: { mode: 'database', urlFor: (id) => urlFor(id) },
  concurrency: 5,
  onResult: (r) => console.log(r.tenantId, r.ok ? 'ok' : r.error),
})

// Schema-per-tenant instead: one base URL, and an admin client that can
// CREATE SCHEMA IF NOT EXISTS before migrating.
const admin = new PrismaClient()
await migrateTenants({
  tenants: ids,
  target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
})
```

The default migrator shells out to `prisma migrate deploy` with each tenant's
scoped URL as `DATABASE_URL`; pass your own `migrate` fn to override it.

Wire it as a CLI command with `tenantMigrateCommand(...)` so `deploy` can run
`basalt tenant:migrate` after shipping new store models (the `Auth*`, `Perm*`,
`Comment` … models from each `*-prisma` package's reference schema). It prints a
per-tenant `ok`/`FAIL` report and exits non-zero if any tenant failed — ideal
for CI/CD:

```ts
import { tenantMigrateCommand } from '@basaltkit/prisma'
import { commandsPlugin } from '@basaltkit/cli'

commandsPlugin([
  tenantMigrateCommand({
    tenants: () => tenants.list().then((all) => all.map((t) => t.id)),
    target: { mode: 'database', urlFor: (id) => urlFor(id) },
  }),
])
```

## Seeding & background work

Outside an HTTP request there's no tenant in context, so `db()` would throw.
Enter one explicitly with `tenancy.run()` — it emits `tenancy:switched`, which
attaches that tenant's client — or sweep them all with `tenancy.forEach()`:

```ts
// seed one tenant
await tenancy.run('acme', async () => {
  await access.store.grantToRole('admin', ['*'], 'acme')
})

// a nightly job across every tenant
await tenancy.forEach(async (tenant) => {
  const stale = await auth.sessions /* … your maintenance … */
}, { concurrency: 5 })
```

The same store instances (`auth`, `access`, …) work in every context — the proxy
routes each call to the tenant that `run`/`forEach` put in scope.

## Putting it together

The full shape of a database-per-tenant app on Basalt:

1. **`tenancyPlugin`** resolves the tenant (subdomain, header, route, …).
2. **`prismaPlugin({ forTenant })`** builds/pools a client per tenant and puts it
   in context.
3. A **`tenantDb` proxy** turns `db()` into a stable `PrismaClient` you can build
   stores over once.
4. The **`*-prisma` stores** over that proxy give every domain — auth, teams,
   subscriptions, permissions, comments, audit, activity, notifications — its own
   isolated, durable home per tenant.
5. **`migrateTenants` / `tenantMigrateCommand`** keep every tenant's schema in
   step on deploy.

You write ordinary handlers; the tenant boundary is enforced by the connection,
not by discipline. See [Persistence](/guide/persistence) for the store catalog
and [Multi-tenancy](/guide/tenancy) for tenant resolution.
