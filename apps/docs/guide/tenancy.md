# Multi-tenancy

`@basaltkit/tenancy` makes every request tenant-aware: a **resolver** identifies
the tenant from the incoming request, a **`TenantSource`** loads its record, and
the result lives in the request context — where cache, storage, queue, logger and
your Prisma client pick it up automatically. It is decoupled from auth and teams:
resolving a tenant answers *which* tenant a request is about, never *whether the
caller may act on it*.

[[toc]]

## Mental model

Four pieces, in the order they run:

| Piece | Runs | Responsibility |
| --- | --- | --- |
| `TenantResolver` | per request, in the order you list them | Maps the request to a `TenantRef` — `{ id }` or `{ domain }` |
| `TenantSource` | once a resolver produced a ref | Loads the tenant record (`find` / `findByDomain`). A ref that loads nothing falls through to the **next** resolver |
| `ctx().tenant` | for the rest of the request | The resolved open record — `undefined` when nothing matched |
| `tenancy:switched` | on every entry into a tenant | Lets cache, storage and the db client re-attach their per-tenant instance |
| `tenancy:created` | once, after a new tenant is created **and provisioned** | Welcome email, audit entry, notifying a panel — a listener may assume the tenant's storage exists |

Outside a request there is no resolver, so you enter a tenant explicitly with
`tenancy.run(id, fn)` — jobs, CLI commands and maintenance scripts all go through
it, and the same hook fires.

::: danger Resolution is identification, never authorization
A resolved tenant only says which tenant the request *claims* to be about. It
does not check that the caller belongs to it — with `headerResolver` a logged-in
user of tenant A can simply send `x-tenant-id: b`. Enforce membership separately
with `tenantMembershipPlugin` from [Teams](/guide/teams), which rejects
non-members app-wide with `403 TEAM_NOT_A_MEMBER`.
:::

## Quickstart

A complete app that boots and serves one tenant-aware route:

```ts
import { createApp, ctx } from '@basaltkit/core'
import { fastifyPlugin, route, FASTIFY } from '@basaltkit/fastify'
import { tenancyPlugin, MemoryTenantSource, headerResolver } from '@basaltkit/tenancy'

const app = await createApp({
  plugins: [
    tenancyPlugin({
      source: new MemoryTenantSource().add({ id: 'acme', name: 'Acme Inc', plan: 'pro' }),
      resolvers: [headerResolver()], // x-tenant-id: acme
    }),
    fastifyPlugin({
      routes: [
        route({
          method: 'GET',
          url: '/whoami',
          async handler() {
            const tenant = ctx().tenant
            return { tenant: tenant?.id ?? null, plan: tenant?.plan ?? 'free' }
          },
        }),
      ],
    }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

```bash
curl http://localhost:3000/whoami -H 'x-tenant-id: acme'
# → {"tenant":"acme","plan":"pro"}
curl http://localhost:3000/whoami
# → {"tenant":null,"plan":"free"}   (no tenant resolved — see `required` below)
```

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
import { CustomDomains, findByVerifiedDomain } from '@basaltkit/tenancy'

const domains = new CustomDomains({ store }) // store defaults to in-memory

// 1. Tenant adds their domain → you show them the DNS record to publish
const { dns } = await domains.add('acme', 'app.acme.com')
// dns → { type: 'TXT', host: '_basalt-verify.app.acme.com', value: 'basalt-domain-verify=…' }

// 2. Once they've added it, verify — a real DNS lookup confirms the token.
//    verify/instructions/remove are scoped to the owning tenant.
if (await domains.verify('acme', 'app.acme.com')) { /* live */ }

// 3. Wire verified domains into your source with the built-in helper — a forged
//    or unverified Host header can never resolve to a tenant.
const source: TenantSource = {
  async find(id) { /* … */ },
  findByDomain: findByVerifiedDomain(domains, (id) => /* load tenant */ this.find(id)),
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

A real SaaS creates tenants when a customer signs up, and the person clicking
**Create** in a panel usually has neither the knowledge nor the access to run a
migration afterwards. Declare `onProvision` **once**, and every creation path —
an admin route, `basalt tenant:create`, a seed script — brings the tenant's
storage into existence before anything can route a request to it.

```ts
// src/app.ts
import { provisionTenantSchema, tenantSchema, migrateTenants } from '@basaltkit/prisma'

tenancyPlugin({
  source,
  resolvers: [subdomainResolver({ base: 'example.com' })],

  async onProvision(tenant) {
    const admin = new PrismaClient()
    await provisionTenantSchema(admin, tenantSchema(tenant.id))   // CREATE SCHEMA IF NOT EXISTS
    await migrateTenants({
      tenants: [tenant.id],
      target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
    })
  },
})
```

Then create through the **service**, never through the source:

```ts
// src/modules/tenants/tenants.routes.ts
route({
  method: 'POST',
  url: '/tenants',
  meta: { auth: true },                       // admin-guarded
  body: z.object({ id: z.string().min(1), name: z.string() }),
  async handler({ body }) {
    // persists → provisions → emits tenancy:created, in that order
    return ctx().container.get(TENANCY).create(body)
  },
})
```

```bash
basalt tenant:create acme --name=Acme
# → Created and provisioned tenant "acme".
```

::: warning `source.create()` skips all of this
The source only writes the row. A tenant whose record exists but whose schema
does not is routable **immediately** — `subdomainResolver` will send it traffic
the moment it is saved — and its first request dies on a raw database error.
Going through `tenancy.create()` is what closes that window.
:::

`onProvision` runs inside the new tenant's context, so `ctx().tenant` and any
tenant-scoped client resolve correctly — the same contract as `onMigrate` and
`onSeed`. Seeding starter data belongs here too:

```ts
async onProvision(tenant) {
  await provisionTenantSchema(admin, tenantSchema(tenant.id))
  await migrateTenants({ tenants: [tenant.id], target })
  await ctx().db.setting.create({ data: { key: 'onboarded', value: 'true' } })
}
```

React to the finished tenant with the hook — it fires only after provisioning
succeeded, so you can safely touch the new tenant's data:

```ts
app.hooks.on('tenancy:created', async ({ tenant }) => {
  await mailer.send({ to: owner(tenant), subject: `${tenant.name} is ready` })
})
```

::: danger Make `onProvision` idempotent
If it throws, the error reaches your caller and `tenancy:created` does **not**
fire — but the tenant record was already written, because the source persists
first. That half-state is deliberately not rolled back: not every
`TenantSource` can delete, and a failed delete on top of a failed provision
destroys the evidence. Write it so a retry can finish the job —
`CREATE SCHEMA IF NOT EXISTS`, `migrate deploy`.

It also runs **inline**: an HTTP handler calling `create()` waits for the whole
migration. That is fine for a schema and a handful of migrations, and wrong for
anything slow — hand the slow part to a queued job and let the route return.
:::

### When provisioning outlives the request

`onProvision` runs inline by default: `create()` waits for it, and the caller
knows the tenant is usable when it returns. That is right for a schema and a
handful of migrations, and wrong once the work is slow enough to outlive an HTTP
request.

Switch to `provision: 'deferred'` and `create()` returns as soon as the record is
written, marked `provisioning`:

```ts
tenancyPlugin({ source, resolvers, onProvision, provision: 'deferred' })
```

```ts
const tenant = await tenancy.create({ id: 'acme' })
tenant.status                                    // 'provisioning'
// …and requests routed to it get 503 until it is finished
```

**Nothing is scheduled for you, and that is deliberate.** Background work runs in
another process, where a closure from this one cannot reach — so the worker
re-enters with the id:

```ts
// jobs/provision-tenant.ts
export const ProvisionTenant = defineJob({
  name: 'tenant.provision',
  handle: ({ id }: { id: string }) => ctx().container.get(TENANCY).provision(id),
})

// wherever you create the tenant
await tenancy.create({ id })                     // returns immediately, 'provisioning'
await ctx().container.get(QUEUE).dispatch(ProvisionTenant, { id })
```

`provision(id)` runs `onProvision`, flips the status to `ready` and emits
`tenancy:created` — the same finish line the inline path crosses. Keep it
idempotent: after a failure the status is `failed`, and a retry has to be able to
complete the job.

That design keeps `@basaltkit/queue` out of `@basaltkit/tenancy` entirely. The
app owns the dispatch, so any scheduler works — a queue, a cron, a manual
`basalt tenant:run`.

### The status, and why 503

| Status | Serves requests | How it gets there |
| --- | :---: | --- |
| *(none)* | ✅ | Every tenant created before provisioning existed. **Treated as ready** — anything else would take a production estate offline on upgrade |
| `ready` | ✅ | `onProvision` succeeded |
| `provisioning` | ❌ 503 | `create()` wrote the record; the work has not finished |
| `failed` | ❌ 503 | `onProvision` threw. The record is kept, not deleted — it is the evidence the tenant was attempted |

**503, not 404.** The tenant exists; it is simply not serving yet, and 503 is the
status a client may retry. A 404 would say the opposite.

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

## Fail-closed scoping — the `tenantScoped()` family

Database rows are the one place isolation is YOUR job: a repository that forgets
the `tenantId` filter returns every tenant's rows — and with Prisma,
`where: { tenantId: ctx().tenant?.id }` silently **drops** the filter when the
tenant is `undefined`, turning a bug into a cross-tenant data leak that returns
`200 OK`. The three helpers exported from `@basaltkit/tenancy` never do that:
when there is nothing to scope to they **throw** rather than return `undefined`.

| Helper | Signature | Returns | Throws when |
| --- | --- | --- | --- |
| `requireTenant()` | `() => Tenant` | The whole tenant record of the active context | No tenant in context |
| `requireTenantId(fallback?)` | `(fallback?: string) => string` | The context tenant's id; else `fallback` | No context tenant **and** no `fallback` |
| `tenantScoped(where?)` | `<W>(where?: W) => W & { tenantId: string }` | Your `where` clause with `tenantId` merged in **last** | No tenant to scope to |

All three throw `TenantRequiredError` (`400 TENANT_REQUIRED`).

```ts
import { requireTenant, requireTenantId, tenantScoped, TenantRequiredError } from '@basaltkit/tenancy'

// A query that can never run unscoped:
const rows = await db.project.findMany({ where: tenantScoped({ archived: false }) })
// → { archived: false, tenantId: 'acme' }

// The whole record, when you need more than the id:
const plan = requireTenant().plan

// System code (a job, a CLI command) may pin one tenant deliberately:
const tenantId = requireTenantId(job.tenantId)
```

Three guarantees are worth stating exactly, because they are what makes the
family safe to use on input-derived data:

- **The context tenant always wins.** `tenantScoped()` spreads `tenantId`
  **last**, so a `tenantId` smuggled into `where` by client input cannot widen
  or switch the scope: `tenantScoped({ tenantId: 'globex' })` inside Acme's
  context still yields `{ tenantId: 'acme' }`.
- **An explicit id is honoured only when there is no context tenant.** That is
  the system-code path — a queue worker or `basalt` command pinning one tenant.
  Inside a request it can never override the resolved tenant.
- **With neither, it throws.** The value is always a real tenant id, never a
  filter that silently disappears. That is the whole point: a `400` beats a
  cross-tenant read.

::: tip The same shape elsewhere
`@basaltkit/activity` exposes the same idea as a query option:
`new Activity({ tenantScoped: 'required' })` makes its trail queries throw
instead of silently returning every tenant's rows. Several packages ship their
own fail-closed variant of the check — `SEARCH_TENANT_REQUIRED`,
`FILE_TENANT_REQUIRED`, `COMMENT_TENANT_REQUIRED`, `AUDIT_TENANT_REQUIRED` —
all with the same meaning: pass a `tenantId` or run inside a tenant context.
:::

These checks are **conditional on tenancy being registered**. `tenancyPlugin`
sets a `tenancy:active` marker in the container metadata, and every generic
package reads it to decide whether to fail closed: with tenancy on,
`SEARCH_TENANT_REQUIRED` / `FILE_TENANT_REQUIRED` / `COMMENT_TENANT_REQUIRED` /
`AUDIT_TENANT_REQUIRED` / `MissingCacheScopeError` all apply; with tenancy off,
there is no tenant dimension and the same calls simply work unscoped. That is
the [beyond-SaaS rule](/guide/beyond-saas) — a generic package never *requires*
tenancy. `@basaltkit/cache` was the first to use the marker, flipping its
`onMissingScope` default from `'global'` to `'error'` in multi-tenant apps; see
[Caching](/guide/caching).

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

## CLI commands

`tenancyPlugin` registers five commands into the CLI bucket, so they show up as
soon as `@basaltkit/cli` is present — no extra wiring:

| Command | Needs | What it does |
| --- | --- | --- |
| `basalt tenant:list` | `source.list()` | Tabulates every tenant (scalar fields only) |
| `basalt tenant:create <id> [--name=… --anyField=…]` | `source.create()` | Persists a new tenant; every flag becomes a field |
| `basalt tenant:migrate [--tenant=<id>]` | `onMigrate` | Runs your per-tenant migration hook inside each tenant's context |
| `basalt tenant:seed [--tenant=<id>]` | `onSeed` | Runs your per-tenant seed hook inside each tenant's context |
| `basalt tenant:run <id> <command> [args…]` | — | Runs any other registered command inside one tenant's context |

`onMigrate` / `onSeed` are where the DB-specific work goes — the framework only
iterates tenants and enters each context:

```ts
tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'basalt.app' })],
  onMigrate: async (tenant) => { await migrateSchemaFor(tenant.id) },
  onSeed: async (tenant) => { await ctx().db.plan.create({ data: { name: 'free' } }) },
})
```

A missing hook is reported (`No migrate hook configured. …`) with exit code 1
rather than silently doing nothing; a `TenantSource` that doesn't implement
`list()` / `create()` is reported the same way.

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

## Options reference

`tenancyPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `source` | `TenantSource` | — (required) | Where tenant records are loaded from — `MemoryTenantSource` in dev, `tenancy-sqlite`/`tenancy-prisma` (or your own table) in production |
| `resolvers` | `TenantResolver[]` | — (required) | Tried in order; the first ref that loads an existing tenant wins, so you can layer a header resolver behind a subdomain one |
| `required` | `boolean` | `false` | Reject a request that resolved no tenant with `404 TENANCY_NOT_RESOLVED`, instead of running it tenant-less. Leave `false` when you also serve central routes (landing page, sign-up) |
| `onMigrate` | `(tenant) => void \| Promise<void>` | — | Per-tenant work for `basalt tenant:migrate`, run inside each tenant's context |
| `onSeed` | `(tenant) => void \| Promise<void>` | — | Per-tenant work for `basalt tenant:seed`, run inside each tenant's context |
| `onProvision` | `(tenant) => void \| Promise<void>` | — | Brings a NEW tenant's storage into existence, inside its context, from `tenancy.create()` and `basalt tenant:create`. Without it a tenant is routable before its schema exists |
| `provision` | `'inline' \| 'deferred'` | `'inline'` | `'inline'` — `create()` waits, so the tenant is usable when it returns. `'deferred'` — `create()` returns immediately with status `provisioning` and the resolver answers 503 until `tenancy.provision(id)` runs |

The built-in resolver factories:

| Factory | Option | Type | Default | Purpose |
| --- | --- | --- | --- | --- |
| `subdomainResolver({ base })` | `base` | `string` | — (required) | The apex your tenants live under. `acme.basalt.app` → `{ id: 'acme' }`; `www`, the bare base, and nested subdomains (`a.b.basalt.app`) are ignored |
| `domainResolver()` | — | — | — | Whole `Host` → `{ domain }`, resolved through `source.findByDomain`. For customer-owned domains; requires that method |
| `headerResolver({ header })` | `header` | `string` | `'x-tenant-id'` | Reads a request header → `{ id: <value> }`. Change it when your gateway already injects a different header |
| `routeResolver({ param })` | `param` | `string` | `'tenant'` | Reads a route param → `{ id: params.tenant }`. For path-based tenancy (`/t/:tenant/…`) |

Every factory returns a plain `TenantResolver` — `(request) => TenantRef | null`
— so a custom one drops into the same array. The `Host` value is canonicalised
(lower-cased, port and trailing dots stripped, IDNA-encoded) before matching, so
`Victim.com:443`, `victim.com.` and a unicode homograph all key the same way.

`new CustomDomains(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `DomainStore` | `new MemoryDomainStore()` | Where registered domains live. A durable implementation **must** back `add()` with a UNIQUE constraint — that insert is the anti-hijack gate |
| `now` | `() => number` | `Date.now` | Injectable clock (tests) |
| `token` | `() => string` | 24 random bytes, base64url | Verification-token generator (tests) |
| `resolveTxt` | `(host) => Promise<string[][]>` | `node:dns/promises` `resolveTxt` | DNS lookup used by `verify()`; stub it in tests |

`domains.verify(tenantId, domain, { force })` short-circuits on an
already-verified domain unless `force` is set. Run it with `force: true` on a
schedule: a domain whose DNS was later removed or repointed is **un**-verified on
a failed re-check and stops resolving — the defence against dangling-domain
takeover.

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `TenantRequiredError` | `TENANT_REQUIRED` | 400 | `tenantScoped()` / `requireTenantId()` / `requireTenant()` ran with no tenant in context and no explicit fallback |
| `TenancyNotResolvedError` | `TENANCY_NOT_RESOLVED` | 404 | `required: true` and no resolver produced a ref that loaded a tenant |
| `TenantNotFoundError` | `TENANT_NOT_FOUND` | 500 | `tenancy.run('unknown-id', …)`, or `forEach()` on a `TenantSource` without `list()` |
| `TenantNotReadyError` | `TENANT_NOT_READY` | **503** | A request resolved to a tenant whose status is `provisioning` or `failed`. 503, not 404: the tenant exists and the client may retry |
| `TenantCreateUnsupportedError` | `TENANT_CREATE_UNSUPPORTED` | 500 | `tenancy.create()` on a source implementing neither `create()` nor `save()` — e.g. one backed by a static config file |
| `DomainTakenError` | `DOMAIN_TAKEN` | 409 | `domains.add()` for a domain another tenant already registered |
| `DomainNotFoundError` | `DOMAIN_NOT_FOUND` | 404 | `verify` / `instructions` / `remove` for a domain that isn't registered |
| `DomainForbiddenError` | `DOMAIN_FORBIDDEN` | 403 | A tenant acted on a domain belonging to a **different** tenant |
| `MissingCacheScopeError` | `CACHE_SCOPE_MISSING` | 500 | A cache read/write ran with no tenant while tenancy is active — see [Caching](/guide/caching) |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 | `tenantMembershipPlugin` found no membership for the user in the resolved tenant — see [Teams](/guide/teams) |

- **`TENANT_REQUIRED` on a background job or a script** — there is no resolver
  outside a request. Wrap the work in `tenancy.run(tenantId, …)`, or pass the id
  explicitly: `requireTenantId(job.tenantId)`.
- **`TENANT_REQUIRED` on a legitimately central route** (sign-up, landing page,
  platform admin) — those routes shouldn't be calling `tenantScoped()` at all.
  Query the unscoped table deliberately, and keep `required: false` on the plugin.
- **`TENANCY_NOT_RESOLVED` although the header/subdomain looks right** — the ref
  resolved but the record didn't load. An unknown id falls through *silently* to
  the next resolver, so this is almost always a tenant missing from the source
  (or, with `domainResolver`, a domain that was never **verified**). Check with
  `basalt tenant:list`.
- **`403 TEAM_NOT_A_MEMBER` right after switching tenants** — expected, and the
  point: the tenant resolved, the membership check then refused it. Tenant
  resolution is identification, never authorization — see [Teams](/guide/teams).
- **A custom domain stopped resolving on its own** — a scheduled
  `verify(…, { force: true })` re-check failed and un-verified it. Re-publish the
  `_basalt-verify.<domain>` TXT record.

## Events

| Hook | Payload |
| --- | --- |
| `tenancy:switched` | `{ tenant }` — emitted on every entry into a tenant context, by the HTTP enricher and by `tenancy.run()` |
| `tenancy:created` | `{ tenant }` — emitted once a new tenant is created **and provisioned**, so a listener may assume its storage exists. Does not fire if `onProvision` threw |

Durable tenant registries and the per-tenant database options are covered in
[Persistence](/guide/persistence); the end-to-end sign-up flow is in the
[multi-tenant SaaS cookbook](/cookbook/multi-tenant-saas) and
[Creating a tenant](/guide/creating-a-tenant).
