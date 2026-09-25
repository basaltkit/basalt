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
`PrismaClient` **once, at boot** — long before a request exists. Under
database-per-tenant the right client is only known per request, so what they
must hold is not a client but a way to reach one. That is `tenantClient()`:

```ts
import { tenantClient } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { prismaAccessStore } from '@basaltkit/permissions-prisma'
import { prismaCommentsStore } from '@basaltkit/comments-prisma'

// Every access resolves to the ACTIVE tenant's client. Build once.
const tenantDb = tenantClient<PrismaClient>()

const auth = prismaAuthStores(tenantDb)
const access = prismaAccessStore(tenantDb)
const comments = prismaCommentsStore(tenantDb)
```

::: warning Don't hand-roll this proxy
A two-line `new Proxy({}, { get: (_t, p) => db()[p] })` looks equivalent, and
for `client.user.findMany()` it is. It is still the wrong tool, for two reasons.

A `get` trap alone is only half a client. `'user' in client` answers `false`,
`Object.keys(client)` answers `[]` and `Object.getOwnPropertyDescriptor` finds
nothing — not errors, wrong answers, given to any store that probes the client
before using it. `tenantClient()` implements `has`, `ownKeys` and
`getOwnPropertyDescriptor` against the live client, and forwards `get` with
`Reflect` so accessor properties see the same receiver they would on the client.

And the usual mistake with a hand-rolled proxy is not the proxy at all: it is
passing the central client to the store "for now", because a client is what the
signature asks for. That raises no error. Every tenant reads and writes the
central schema, silently. A primitive that takes no client leaves nothing to get
wrong.
:::

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

## Serving central and tenant routes from one app

Most apps are not purely multi-tenant. There is a landing page, a sign-up form,
an admin area and a health check that belong to **nobody** — plus the tenant
routes that belong to exactly one. Both live in the same process.

`prismaPlugin` covers this in a single registration: `client` is used when the
context has no tenant, and the per-tenant mode when it does.

```ts
prismaPlugin({
  // No tenant resolved → this client (the central database / `public` schema).
  client: prisma,
  // Tenant resolved → a client connected with `?schema=tenant_<id>`.
  schemaPerTenant: {
    url: process.env.DATABASE_URL!,
    createClient: (url) => new PrismaClient({ datasourceUrl: url }),
  },
  destroy: (client) => client.$disconnect(),
})
```

`db()` now returns the right client on both kinds of request, so one handler
serves both without branching:

```ts
route({ method: 'GET', url: '/users', meta: { tenant: false }, handler: async () =>
  db<PrismaClient>().authUser.findMany(),  // central on the apex, tenant on a subdomain
})
```

On `app.example.com` that lists the central users; on `acme.example.com`, Acme's.
Same route, same query, no `if`.

### Routes you did not write

Packages mount their own routes — `authRoutes()`, `mfaRoutes()`, `billingRoutes()`
— so you cannot put `meta` on them by hand. Map over them instead:

```ts
const central = <T extends { meta?: Record<string, unknown> }>(routes: T[]): T[] =>
  routes.map((r) => ({ ...r, meta: { ...r.meta, tenant: false } }))

fastifyPlugin({ routes: [...central(authRoutes()), ...central(mfaRoutes())] })
```

`tenant: false` lifts the *requirement*, not the resolution — a request to
`acme.example.com/auth/login` still resolves Acme, so the auth stores read Acme's
schema. The result is one set of auth routes serving two populations:

| Request | Authenticates against |
| --- | --- |
| `app.example.com/auth/login` | central users |
| `acme.example.com/auth/login` | Acme's users |

A central user cannot log in on a tenant subdomain, and a tenant user cannot log
in on the apex — not because a handler checks, but because the two look in
different schemas.

### The central plane is not a second identity system

This is the point people miss, and it is expensive to miss. The staff who
**operate** the SaaS — owner, support, finance, ops — are a different population
from the people inside each customer company. Same e-mail in both places is not
the same person, and a central account must never open a tenant.

That separation is real and it matters. What it does **not** need is a second
authentication stack. Because `db()` follows the plane of the request, the
central population gets `authPlugin`, `authRoutes()`, `mfaRoutes()`, password
recovery, sessions, API keys and `permissionsPlugin` — all of it — from the
registration you already made:

```ts
// prisma/schema.prisma          → the CENTRAL plane (public schema)
model AuthUser  { id String @id  email String @unique  passwordHash String  … }
model AuthSession { … }
model PermUserRole { scope String  userId String  role String  @@id([scope, userId, role]) }
model Tenant  { … }   // the customer register, plans, subscriptions, payments

// prisma/tenants/schema.prisma  → what every customer company owns
generator client { provider = "prisma-client-js", output = "../../generated/tenant" }
model AuthUser  { id String @id  email String @unique  passwordHash String  … }
model Invoice   { id String @id  … }   // no tenantId: the schema IS the tenant
```

Two schemas, **two generators**, two clients. The second `output` is not
cosmetic: with one client both plane's models must be declared in one schema, so
the central database grows tables that are supposed to stay empty forever — and
an empty table in the wrong plane is exactly where a stray write lands.

Authorising the central area is then the ordinary permissions system with a
scope of its own:

```ts
import { GLOBAL_SCOPE } from '@basaltkit/permissions'

export const PLATFORM_ADMIN = 'platform_admin'

// Bound to the CENTRAL client explicitly — this seeds and grants outside any
// request, where db() has no plane to follow and therefore throws.
const centralAccess = prismaAccessStore(prisma).store
await centralAccess.grantToRole(PLATFORM_ADMIN, ['tenant:approve', 'platform:read'], GLOBAL_SCOPE)

route({ method: 'POST', url: '/central/admin/tenants/:id/approve',
        meta: { tenant: false, auth: true, can: 'tenant:approve' }, handler })
```

The scope is `GLOBAL_SCOPE`, not a string of your own. A request with no
tenant is evaluated in `GLOBAL_SCOPE` (`'@global'`) and the Gate reads nothing
else there: a grant written under `'global'` — the pre-1.5 value — is never
consulted, so the route above would deny the very administrator you just
created, and nothing tells you why. See
[the global scope can't be a tenant](/guide/authorization#the-global-scope-can-t-be-a-tenant).

`meta: { tenant: false, auth: true, can: '…' }` — the same three keys every
tenant route uses. Name the first administrator from the CLI, not from a route:
the first one has nobody to appoint them, and an unprotected "create the first
admin" endpoint is the door that stays open because nobody remembers to close
it. Whoever can run a command on the server can already reach the database.

::: danger The anti-pattern: a bespoke operator identity
The tempting shortcut is a `PlatformOperator` model with its own password
hashing, its own session table, its own cookie, its own CSRF token and its own
`if (role === 'OWNER')`. It is quick to write and it looks like good isolation.

It is not. It is a second security-critical codebase that starts with none of
what the framework already gives you, and you will re-implement each piece badly
and late: password recovery, TOTP and its replay window, invitation links,
lockout, session revocation, a permission catalogue, an audit trail. Meanwhile
the people running the service are protected *worse* than the customers they
sell to — which is backwards.

If you catch yourself writing `requireOperator()`, stop: the separation you want
is the one `db()` already gives you, and `can:` already expresses the rest.
:::

::: warning This trades a loud failure for a quiet one
Without `client`, a tenant route reached with no tenant throws `DB_UNAVAILABLE`.
With `client` set, that same route would quietly query the **central** database
instead — the mistake still happens, but silently, and against the wrong data.

What keeps that safe is refusing the request before the handler runs: set
`required: true` on `tenancyPlugin`, and mark only the routes that genuinely
belong in the central context. See
[separating central routes from tenant routes](/guide/tenancy#separating-central-routes-from-tenant-routes).

So `meta: { tenant: false }` is a claim you are making about the route: *this
one is meaningful without a tenant.* Marking a tenant-only route that way is how
you build the silent-wrong-data bug this option is otherwise protecting you from.
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

### Where the tenant migrations live

Tenants usually have their own schema file, and therefore their own migration
history — separate from the central one. Pointing at the tenant *models* is not
enough to pick up the tenant *migrations*:

```ts
// Wrong: --schema moves the models, but `migrations.path` belongs to your
// prisma.config.ts, so Prisma still applies the CENTRAL migration history.
prismaMigrator({ schemaPath: './prisma/tenants/schema.prisma' })
```

The symptom is unmistakable once you know it: a freshly provisioned tenant
comes up holding `_prisma_migrations` and not one table of its own. Prisma
applied a history that has nothing to do with these models.

Give the tenants a config that pins both, and pass `configPath`:

```ts
// prisma/tenants/prisma.config.ts
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  // Relative to THIS file's directory — not the project root. The config at
  // your project root uses root-relative paths, which makes this easy to miss.
  schema: 'schema.prisma',
  migrations: { path: 'migrations' },
  datasource: { url: env('DATABASE_URL') },
})
```

```ts
prismaMigrator({ configPath: './prisma/tenants/prisma.config.ts' })
```

Generate that first migration from the tenant schema with
`prisma migrate diff --from-empty --to-schema-datamodel prisma/tenants/schema.prisma --script`.

::: tip Prisma skips `.env` when a config is loaded
So the config must read its URL from the environment, as above. `prismaMigrator`
always sets `DATABASE_URL` to the tenant's scoped URL, so `env('DATABASE_URL')`
resolves to the right tenant on every run.
:::

### A clean exit is not proof anything happened

`prisma migrate deploy` exits 0 when it finds **no** migrations to apply. If the
migrations directory is missing or empty — a fresh clone, a `.gitignore` that
caught it, a config pointing at the wrong one — the tenant is provisioned, the
migrator reports success, and the schema comes up holding `_prisma_migrations`
and nothing else. The tenant is then marked ready, and the damage surfaces much
later as a query against a table that was never created.

`migrateTenants` checks for this. After each tenant migrates it counts the
tables in that tenant's schema, ignoring `_prisma_migrations`, and reports
`ok: false` when the count is zero:

```
PRISMA_TENANT_SCHEMA_EMPTY: The migration reported success but tenant schema
"tenant_acme" has no tables.
```

It runs in schema mode when `provision` can also read the database — a
`PrismaClient` can, so `provision: admin` is enough. It is one `information_schema`
query per tenant, and like every other failure it is reported per tenant without
aborting the rest of the run. Pass `verifyTables: false` if a tenant legitimately
starts empty.

::: tip This is why the check counts tables, not migrations
`prisma db push` creates the tables straight from `schema.prisma`, with no
migration history at all. Asking "were migrations applied?" would report a false
failure for that strategy; asking "does the tenant have tables?" is the right
question for both.
:::

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
