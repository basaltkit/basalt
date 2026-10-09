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
| `TenantResolver` | per request — authoritative ones (subdomain, domain, route) first, then fallbacks (header), each in list order | Maps the request to a `TenantRef` — `{ id }` or `{ domain }` |
| `TenantSource` | once a resolver produced a ref | Loads the tenant record (`find` / `findByDomain`). An unknown ref from an **authoritative** resolver ends resolution with no tenant; from a fallback it moves on to the next fallback |
| `ctx().tenant` | for the rest of the request | The resolved open record — `undefined` when nothing matched |
| `tenancy:switched` | on every entry into a tenant | Lets cache, storage and the db client re-attach their per-tenant instance |
| `tenancy:exited` | when a `tenancy.run()` callback settles | Releases what a `tenancy:switched` listener took (the leased database client) |
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

A **resolver** maps an incoming request to a tenant reference. You pass a list,
and resolvers come in two kinds:

- **Authoritative** — `subdomainResolver`, `domainResolver`, `routeResolver`, and
  any custom resolver wrapped in `authoritative(fn)`. They read something the
  platform controls, so they always run **first**, whatever the list order; the
  first reference that loads an existing tenant wins. If an authoritative
  resolver names a tenant that does **not** exist, the request resolves to **no
  tenant** — it never falls through to a client-controlled resolver.
- **Fallback** — `headerResolver` and unmarked custom resolvers. They run, in
  list order, only when no authoritative resolver named anything (the bare apex,
  `www`, `localhost`).

So `nosuch.basalt.app` with `x-tenant-id: globex` is **not** `globex`, and a
header can never override `acme.basalt.app`. A reference whose id fails the
tenant-id grammar (see below), or whose domain is not a valid hostname, counts as
not found and never reaches the source.

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
    subdomainResolver({ base: 'basalt.app' }), // acme.basalt.app — authoritative
    headerResolver(),                          // x-tenant-id: acme — only on the bare apex
  ],
})
```

Prefer an error to a precedence rule when resolvers disagree? Pass
`onConflict: 'error'`: every resolver runs, and two that load **different**
tenants answer `400 TENANCY_CONFLICT` (at the cost of one lookup per resolver).

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
fit — e.g. deriving the tenant from a claim your gateway signed and put on the
request. An unmarked resolver is a **fallback**; wrap it in `authoritative()` only
when clients cannot forge its input:

```ts
import { authoritative } from '@basaltkit/tenancy'

const claimResolver = authoritative((request) => {
  const org = request.headers?.['x-org-claim'] // set by the gateway, stripped from client requests
  return typeof org === 'string' ? { id: org } : null
})

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

An unverified claim does not block the real owner forever. After `claimTtlMs`
(72 h by default) another tenant's `add()` takes the domain over; with
`challengeSecret` set the owner need not wait — it publishes the record returned
by `domains.challenge(tenantId, domain)` and its `add()` wins immediately,
already verified. Set `reservedDomains` to your platform apex so nobody can claim
it or any subdomain of it:

```ts
const domains = new CustomDomains({
  store,
  reservedDomains: ['basalt.app'],        // DOMAIN_RESERVED for basalt.app and *.basalt.app
  challengeSecret: env.DOMAIN_CHALLENGE_SECRET, // same value on every instance
})
```

Domains are held to the RFC 1123 hostname grammar: `normalizeDomain()` rejects
userinfo (`acme.basalt.app@evil.com`), paths, `%`-escapes, non-ASCII and IP
literals with `400 DOMAIN_INVALID` instead of rewriting them. Register an
internationalized domain in its `xn--` form (`domainToASCII()` from `node:url`).

`verify()` does a live `TXT` lookup via `node:dns` (injectable for tests). TLS
certificate provisioning is infrastructure — issue the cert with your platform
(Cloudflare, Caddy, ACME) once `verify()` returns `true`.

### A durable domain store

`MemoryDomainStore` forgets every claim and proof on restart. The two durable
tenant sources each ship a matching store on the same `tenant_domains` table:

```ts
import { prismaDomainStore, prismaTenantSource } from '@basaltkit/tenancy-prisma'
// or: import { sqliteDomainStore, sqliteTenantSource } from '@basaltkit/tenancy-sqlite'

const tenants = prismaTenantSource(prisma)
const domains = new CustomDomains({
  store: prismaDomainStore(prisma),   // sqliteDomainStore(tenants.db) for SQLite
  reservedDomains: ['basalt.app'],
})
tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'basalt.app' }), domainResolver()] })
```

No `findByVerifiedDomain` is needed with these: the source's own `findByDomain`
is fail-closed, so a claim resolves only once verified and a domain another
tenant merely claimed (`victim.com`) never routes a request. The table holds two
kinds of row, told apart by `verificationToken`:

| Row | Written by | `save()` / `provision()` | Resolves |
| --- | --- | --- | --- |
| mirror (`verificationToken` NULL) | the source, from `tenant.domains` | kept in line with `tenant.domains` | always |
| claim (`verificationToken` set) | the domain store | never deleted | once `verified` |

So re-provisioning a tenant or changing its status never erases a verified
custom domain or its proof. A domain is one row whichever kind it is: claiming a
domain already on some `tenant.domains` throws `DOMAIN_TAKEN` (409), translated
from the driver's unique violation inside the store.

The Prisma store needs the verification columns of the bundled `TenantDomain`
model (`verificationToken`, `verified`, `createdAt`, `verifiedAt`) — an additive
migration: re-run `basalt prisma:sync`, then `prisma migrate dev`. The SQLite
source adds them on open.

Writing a store of your own? Run the shared contract against it — it lives on
a test-only subpath and works with any runner:

```ts
import { domainStoreContract } from '@basaltkit/tenancy/testing'

describe('MyDomainStore', () => {
  for (const c of domainStoreContract(() => new MyDomainStore(db))) it(c.name, c.run)
})
```

## Creating tenants

How you create a tenant depends on the backend.

::: warning Tenant ids follow one grammar
A tenant id is not an opaque label: it becomes a namespace segment in the cache
(`tenant:<id>:`), in storage (`tenants/<id>/`), in realtime channels and in
schema names. `tenancy.create()` and `MemoryTenantSource.create()/save()`
therefore refuse, with `InvalidTenantIdError` (`400 TENANT_ID_INVALID`), any id
outside `/^[a-z0-9][a-z0-9_-]{0,62}$/` or equal to the reserved `global` — so a
self-serve signup cannot pick `globex:user`, `globex/files` or `..` to alias
another tenant's keys or files. Slugs, UUIDs and cuids fit. `isValidTenantId(id)`
is exported for your own signup form; pass `validateTenantId` to `tenancyPlugin`
(and the same function to `new MemoryTenantSource({ validateTenantId })`) to
narrow or widen it — keep `:`, `/`, `\`, `.`, whitespace and control characters
out of any replacement.
:::

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
tenants across a restart. Both ship `create`/`save`/`find`/`findByDomain`/`list`/`remove`:

```ts
import { sqliteTenantSource } from '@basaltkit/tenancy-sqlite'   // single node, zero-dep
// import { prismaTenantSource } from '@basaltkit/tenancy-prisma' // Postgres/MySQL

const tenants = sqliteTenantSource('./data/tenants.db')

// save() is an upsert — create or update a tenant. Any extra field round-trips.
await tenants.save({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })
// create() only inserts — an id that already exists throws TenantAlreadyExistsError.
await tenants.create({ id: 'globex', name: 'Globex' })

tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'basalt.app' }), domainResolver()],
})
```

`save` and `create` bring the tenant's domain rows in line with `tenant.domains`
(domains claimed through `CustomDomains` are left alone — see
[a durable domain store](#a-durable-domain-store)); a domain already owned by
another tenant is rejected (routing must be unambiguous). See [Persistence](/guide/persistence).

::: tip Prisma-backed registry
`prismaTenantSource(prisma)` stores the registry in the Postgres/MySQL database
you already run — ideal for multiple instances sharing one tenant list. Add its
two models with `basalt prisma:sync --push`, then pass your generated
`PrismaClient`. Same `create`/`save`/`find`/`findByDomain`/`list`/`remove` surface.
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

::: tip `create()` never overwrites an existing tenant
An id that already exists — whatever its status — is refused with
`TenantAlreadyExistsError` (`409 TENANT_ALREADY_EXISTS`) before anything is
written: no hook fires and `onProvision` does not run, so a double-submitted
signup cannot replace a tenant's owner or re-provision live storage. A tenant
left `failed` (or still `provisioning`) is finished with `tenancy.provision(id)`,
not by creating it again; an intentional update of the record is `source.save()`.
The durable sources refuse the duplicate in the insert itself, so of two
concurrent creates of the same id exactly one wins.
:::

`onProvision` runs inside the new tenant's context, so `ctx().tenant` and any
tenant-scoped client resolve correctly — the same contract as `onMigrate` and
`onSeed`. Seeding starter data belongs here too:

```ts
async onProvision(tenant) {
  await provisionTenantSchema(admin, tenantSchema(tenant.id))
  await migrateTenants({ tenants: [tenant.id], target })
  await db<PrismaClient>().setting.create({ data: { key: 'onboarded', value: 'true' } })
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
destroys the evidence. Write it so a retry — `tenancy.provision(id)` — can
finish the job: `CREATE SCHEMA IF NOT EXISTS`, `migrate deploy`.

It also runs **inline**: an HTTP handler calling `create()` waits for the whole
migration. That is fine for a schema and a handful of migrations, and wrong for
anything slow — hand the slow part to a queued job and let the route return.
:::

### The address a tenant is created with

Every durable `TenantSource` reads a tenant's addresses from one key —
`tenant.domains` — and an application that never passes it creates tenants with
none. Silently, too: `subdomainResolver` slices the suffix off the `Host` and
answers without ever consulting the table, so the tenant serves traffic and what
is missing is only the **record** that the address belongs to it.

Nothing breaks until something needs that record. `domainResolver()` cannot find
the tenant, a custom domain cannot be attached to it, and nothing stops a second
tenant claiming the same address — the uniqueness lives in the table that stayed
empty. It is the worst kind of gap: it does not fail, it omits. An installation
can run for a year with an empty domain set and discover it when the first
customer asks for their own domain, with every historical row to backfill.

Declare it once, on the plugin:

```ts
tenancyPlugin({
  source,
  resolvers: [subdomainResolver({ base: 'example.com' })],
  canonicalDomain: (tenant) => `${tenant.id}.${process.env.APP_DOMAIN}`,
})
```

`tenancy.create()` applies it before the record is persisted, so every creation
path gets it — public signup, an admin route, `basalt tenant:create`, a seed
script — instead of each one remembering. Return `undefined` to decline, for a
tenant that should have no address of its own.

::: tip It is added, never substituted
The canonical domain joins whatever the tenant already declares. Sources replace
the **whole** domain set on save, so substituting would erase a customer's own
`app.acme.com` the next time anything called `create()`.
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
| *(none, or `null`)* | ✅ | Every tenant created before provisioning existed. **Treated as ready** — anything else would take a production estate offline on upgrade |
| `ready` | ✅ | `onProvision` succeeded |
| `provisioning` | ❌ 503 | `create()` wrote the record; the work has not finished |
| `failed` | ❌ 503 | `onProvision` threw. The record is kept, not deleted — it is the evidence the tenant was attempted |
| `deleting` | ❌ 503 | `destroy()` has started. Marked **before** the storage is touched, so no request reaches a schema being dropped underneath it |
| `suspended` | ❌ 403 `TENANT_SUSPENDED` | **Your app** wrote it — billing lapsed, abuse. Tenancy never sets it |
| anything else (`active`, `disabled`, …) | ❌ 500 `TENANT_STATUS_UNKNOWN` | A value tenancy does not recognise. Refused rather than guessed at |

**503, not 404.** The tenant exists; it is simply not serving yet, and 503 is the
status a client may retry. A 404 would say the opposite.

**A suspension is 403, not 503.** The storage is fine and retrying will not help —
the account is locked out until the app lifts the suspension. Lock a tenant out
with `source.save({ ...tenant, status: 'suspended' })`; put it back with `'ready'`.

**An unknown status fails closed.** If your records say `active` for a serving
tenant, tenancy cannot know that means "the storage is usable", so the request is
refused with a message naming the value it saw. Store `ready` (or no status)
instead. `assertTenantServing(tenant)` runs the same check outside HTTP;
`isTenantReady(tenant)` is its boolean form.

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
against global data.

`true` applies to **every** route, which most apps cannot live with: a health
check has no tenant to send, and neither does a landing page or a public pricing
endpoint. Exempt them by path instead of giving up the guard everywhere:

```ts
tenancyPlugin({
  source: tenants,
  resolvers: [headerResolver()],
  required: { except: ['/', '/health', '/openapi.json', /^\/public\//] },
})
```

Entries are exact strings or regular expressions, matched against the path
without its query string — so `/health` still covers `/health?probe=1`. A URL
that cannot be matched at all is treated as **required**, so the guard fails
closed.

### Separating central routes from tenant routes

A path list works, but it puts the decision in a different file from the route
it describes: rename the URL and the exemption silently stops matching. Declare
it on the route instead, with `meta.tenant`:

```ts
// A central route: no tenant, ever.
route({ method: 'GET', url: '/pricing', meta: { tenant: false }, handler })

// A tenant route: refuse the request if none resolved.
route({ method: 'GET', url: '/invoices', meta: { tenant: true }, handler })
```

`meta.tenant` overrides the app-wide `required` in both directions, so the
combination most apps want is **deny by default, opt out per route**:

```ts
tenancyPlugin({ source: tenants, resolvers: [headerResolver()], required: true })
```

Every route now needs a tenant, and the handful of central ones — health check,
landing page, sign-up, tenant creation — say so next to their handler, where a
reviewer sees it. `required: { except }` remains available and still works; use
it for paths you do not own, such as routes mounted by another package.

A route that declares `meta: { tenant: false }` still *resolves* a tenant when
one is present, so `ctx().tenant` is populated on `acme.example.com/pricing`.
Only the requirement is lifted.

#### Central-only routes: `tenant: 'never'`

Some routes must not run inside a tenant at all — the SaaS owner's console:
plans, tenant approval, operator roles. `tenant: false` is not enough there: on
`acme.example.com/platform/plans` the tenant still resolves, the request runs
against Acme's storage, and a tenant owner holding `'*'` satisfies
`can: 'platform:…'`. Declare those routes `'never'`:

```ts
route({
  method: 'GET',
  url: '/platform/plans',
  meta: { tenant: 'never', auth: true, can: 'platform:plans.read' },
  handler,
})
```

When a tenant resolves on such a route, the request is answered with the body
an unmatched route gets — `404 { error: { code: 'NOT_FOUND', message: 'Route not
found.' } }` (`CentralOnlyRouteError`) — before any guard runs, so a 401 or 403
never reveals that the route exists. The tenant is not attached to the context
and `tenancy:switched` is not emitted. On the apex, where no tenant resolves, the
route runs normally. The behaviour is the same on Fastify, Express and Hono.

::: warning List `tenancyPlugin` before the auth plugins
The check runs in the tenancy *enricher*, and enrichers run in plugin order.
The `authPlugin` and `apiKeysPlugin` enrichers can refuse a request themselves
(a 401 for an invalid or expired bearer, a 400 for two disagreeing API keys); if
they come first, that answer reaches the caller instead of the 404 and tells it
the route exists. Put `tenancyPlugin` ahead of them in
`plugins: [...]`.
:::

| `meta.tenant` | No tenant resolved | A tenant resolved |
| --- | --- | --- |
| *(absent)* | app-wide `required` decides | runs in the tenant |
| `true` | `404 TENANCY_NOT_RESOLVED` | runs in the tenant |
| `false` | runs without a tenant | runs in the tenant |
| `'never'` | runs without a tenant | `404 NOT_FOUND`, handler not run |

Any other value (`'none'`, `'false'`, `0`, `null`) falls back to the app-wide
default, as it always did, and logs one boot warning naming the routes: a typo
for `'never'` would otherwise serve the route on tenant hosts. The next major
refuses such a boot with `HTTP_INVALID_ROUTE_META`. `basalt ai doctor` warns
about routes that pair `tenant: false` with a `platform:` permission.

Exempting a path only lifts the tenant requirement. Auth, subscription checks
and every other guard still run.

Keeping `required: false` is still valid when central routes outnumber tenant
ones, but then every handler is responsible for the absent tenant itself.

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
| `tenantScoped(where?)` | `<W>(where?: W) => W & { tenantId: string }` | Your `where` clause with the **context** tenant's `tenantId` merged in **last** | No tenant in context — a `tenantId` in `where` is never used as a fallback |

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
- **`tenantScoped()` takes the tenant from the context only.** A `tenantId`
  inside `where` is never a fallback: `where` is routinely built from client
  input, and with no tenant resolved (`required` defaults to `false`) that would
  let a request pick any tenant by omitting its tenant header. So
  `tenantScoped({ tenantId: 'globex' })` with no context tenant **throws**.
- **An explicit id is honoured only by `requireTenantId(fallback)`, and only
  when there is no context tenant.** That is the system-code path — a queue
  worker or `basalt` command pinning one tenant (or wrap the work in
  `tenancy.run(id, …)`). Inside a request it can never override the resolved
  tenant.
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
import { db } from '@basaltkit/prisma'

const tenancy = app.container.get(TENANCY)

// Pass an id (loaded from the source; throws TenantNotFoundError if unknown)
// or a Tenant object you already have.
const total = await tenancy.run('acme', async () => {
  return db<PrismaClient>().invoice.count() // scoped to Acme
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

A package that must enter a tenant from background code, without depending on
`@basaltkit/tenancy`, reads the same function from the `'tenancy:run'` metadata
signal (type `TenantRunner`): same id check, same `TenantNotFoundError`, same
`tenancy:switched`/`tenancy:exited` pair, no `status` check. It runs from the
caller's context, so enter from `runWithContext({}, ...)` when nothing ambient
may leak in. `@basaltkit/webhooks` uses it for the endpoint lookup of off-request
dispatches — see [Webhooks → Schema-per-tenant](/guide/webhooks#schema-per-tenant).

## CLI commands

`tenancyPlugin` registers six commands into the CLI bucket, so they show up as
soon as `@basaltkit/cli` is present — no extra wiring:

| Command | Needs | What it does |
| --- | --- | --- |
| `basalt tenant:list` | `source.list()` | Tabulates every tenant (scalar fields only) |
| `basalt tenant:create <id> [--name=… --anyField=…]` | `source.create()` or `save()` | Persists a new tenant; every flag becomes a field. An existing id is refused (exit code 1) |
| `basalt tenant:destroy <id> [--force] [--yes]` | `source.delete()` | Marks the tenant `deleting`, runs `onDeprovision` in its context, then removes the record. Asks first; `--yes` skips the question, `--force` removes the record even if teardown failed |
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
  onSeed: async (tenant) => { await db<PrismaClient>().plan.create({ data: { name: 'free' } }) },
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
model. The extension forces the current tenant's filter onto every read and
update, stamps it onto every create (nested creates included), narrows nested
`connect`/`update`/`delete` to the tenant, refuses to move a row to another
tenant, and **refuses** raw or unknown operations inside a tenant context —
code can't forget or override it:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, tenancyExtension } from '@basaltkit/prisma'

const db = new PrismaClient().$extends(
  tenancyExtension({
    tenantField: 'tenantId',   // column name (default 'tenantId')
    // onMissingTenant defaults to 'error': no tenant in context → throws
    // PRISMA_TENANT_MISSING instead of running across every tenant.
  }),
)

prismaPlugin({ client: db })

// Deliberate cross-tenant reads (back-office, jobs) get their OWN client —
// never put 'bypass' on the app's main client.
export const adminDb = new PrismaClient().$extends(
  tenancyExtension({ onMissingTenant: 'bypass' }),
)
```

The extension works on query arguments, so it can't tell which scalar columns
are foreign keys (`data: { projectId }` is not checked). Use composite foreign
keys `(tenantId, id)` and RLS as the database-level guarantee.
`tenancyExtension({ rls: true })` sets the tenant for Postgres RLS on every
operation — see the RLS part of the [Security guide](/guide/security).

**Schema per tenant** — one database, one PostgreSQL schema per tenant. Each
tenant gets a client whose connection URL carries `?schema=tenant_<id>`, so
Prisma sets the `search_path` at connect time (reliable, unlike per-request
`search_path` switching on a shared pool). Clients are held in a bounded pool
(only idle clients are evicted; see [the per-tenant client pool](./database-per-tenant#the-per-tenant-client-pool)):

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

`tenantSchema()` is injective: canonical ids (`acme`, `acme_co`) are used
as-is, and any other id (`ACME`, `acme-co`, UUIDs) gets a `__<hash>` suffix
(`tenant_acme_co__<16 hex>`), so a new tenant can never land in an existing
tenant's schema. Evicted pool clients are closed with `$disconnect()` by
default, and concurrent first requests for a tenant share one client.

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
| `resolvers` | `TenantResolver[]` | — (required) | Authoritative resolvers (subdomain, domain, route, `authoritative(fn)`) first — an unknown tenant they name resolves to none; fallbacks (header) only when no authoritative resolver named anything. Within each group the first ref that loads a tenant wins |
| `onConflict` | `'precedence' \| 'error'` | `'precedence'` | `'error'` runs every resolver and answers `400 TENANCY_CONFLICT` when two load different tenants |
| `required` | `boolean \| { except: (string \| RegExp)[] }` | `false` | Reject a request that resolved no tenant with `404 TENANCY_NOT_RESOLVED`, instead of running it tenant-less. `{ except }` exempts paths (health checks, landing pages) while still guarding the rest |
| `onMigrate` | `(tenant) => void \| Promise<void>` | — | Per-tenant work for `basalt tenant:migrate`, run inside each tenant's context |
| `onSeed` | `(tenant) => void \| Promise<void>` | — | Per-tenant work for `basalt tenant:seed`, run inside each tenant's context |
| `onProvision` | `(tenant) => void \| Promise<void>` | — | Brings a NEW tenant's storage into existence, inside its context, from `tenancy.create()` and `basalt tenant:create`. Without it a tenant is routable before its schema exists |
| `onDeprovision` | `(tenant) => void \| Promise<void>` | — | Tears that storage down, inside the tenant's context, from `tenancy.destroy()`. Without it the record goes and the schema stays |
| `canonicalDomain` | `(tenant) => string \| undefined` | — | The address a new tenant is reachable at, added to `tenant.domains` by `tenancy.create()` before the record is persisted. Without it the domain table stays empty and nothing owns the address |
| `provision` | `'inline' \| 'deferred'` | `'inline'` | `'inline'` — `create()` waits, so the tenant is usable when it returns. `'deferred'` — `create()` returns immediately with status `provisioning` and the resolver answers 503 until `tenancy.provision(id)` runs |
| `validateTenantId` | `(id: string) => boolean` | `isValidTenantId` | The id grammar `tenancy.create()` and `tenancy.run()` enforce (`/^[a-z0-9][a-z0-9_-]{0,62}$/`, minus `global`); a rejected id throws `InvalidTenantIdError` before anything is written, and a resolver ref carrying one resolves to no tenant |

The built-in resolver factories:

| Factory | Option | Type | Default | Purpose |
| --- | --- | --- | --- | --- |
| `subdomainResolver({ base })` | `base` | `string` | — (required) | The apex your tenants live under. `acme.basalt.app` → `{ id: 'acme' }`; `www`, the bare base, and nested subdomains (`a.b.basalt.app`) are ignored. Authoritative |
| `domainResolver()` | — | — | — | Whole `Host` → `{ domain }`, resolved through `source.findByDomain`. For customer-owned domains; requires that method. Authoritative |
| `headerResolver({ header })` | `header` | `string` | `'x-tenant-id'` | Reads a request header → `{ id: <value> }`. Change it when your gateway already injects a different header. Fallback (client-controlled) |
| `routeResolver({ param })` | `param` | `string` | `'tenant'` | Reads a route param → `{ id: params.tenant }`. For path-based tenancy (`/t/:tenant/…`). Authoritative |

Every factory returns a plain `TenantResolver` — `(request) => TenantRef | null`,
with an optional `authoritative` flag — so a custom one drops into the same
array. The `Host` value is canonicalised (lower-cased, port and trailing dots
stripped) before matching, so `Victim.com:443` and `victim.com.` key the same way;
a `Host` outside the hostname grammar (userinfo, path, `%`, non-ASCII, IP
literal) matches nothing.

`new CustomDomains(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `DomainStore` | `new MemoryDomainStore()` | Where registered domains live — `prismaDomainStore(prisma)` or `sqliteDomainStore(db)` in production. A durable implementation **must** back `add()` with a UNIQUE constraint and throw `DomainTakenError` — that insert is the anti-hijack gate (check yours with `domainStoreContract` from `@basaltkit/tenancy/testing`) |
| `now` | `() => number` | `Date.now` | Injectable clock (tests) |
| `token` | `() => string` | 24 random bytes, base64url | Verification-token generator (tests) |
| `resolveTxt` | `(host) => Promise<string[][]>` | `node:dns/promises` `resolveTxt` | DNS lookup used by `verify()`; stub it in tests |
| `claimTtlMs` | `number` | 72 h | How long an **unverified** claim holds a domain before another tenant's `add()` can take it. Verified domains never expire (a stale one yields only to a `challenge()` record — see `reverify()`) |
| `reservedDomains` | `string[]` | `[]` | The platform's own domains; each one and every subdomain of it is refused with `DOMAIN_RESERVED` |
| `challengeSecret` | `string` | — | Enables `challenge(tenantId, domain)`: publishing that TXT record lets the owner's `add()` take a squatted unverified claim at once. Same value on every instance |

`domains.verify(tenantId, domain, { force })` short-circuits on an
already-verified domain unless `force` is set. Run it with `force: true` on a
schedule: a domain whose DNS was later removed or repointed is **un**-verified on
a failed re-check and stops resolving — the defence against dangling-domain
takeover.

For a scheduled job, prefer the system-level helpers, which need no tenant id:

```ts
schedule.call('reverify-domains', async () => {
  const { revoked, errors } = await domains.reverifyAll()
  if (revoked.length) log.warn({ revoked }, 'custom domains un-verified')
}).hourly()
```

`domains.reverify(domain)` re-checks whichever tenant holds the domain and
returns `{ domain, tenantId, status }`: `valid`, `revoked` (the record is
definitively gone — NXDOMAIN, no TXT, or no matching value — so the claim is
un-verified), `dns-error` (a timeout or SERVFAIL: left verified, so a DNS
outage never un-verifies every domain at once), `unverified`, or `changed` (the
record changed hands meanwhile; left alone). `reverifyAll()` runs it over
`DomainStore.listVerified()` — or over `{ domains }` you pass, for a store
without that method — and returns `{ checked, revoked, errors, results }`.

A **stale verified claim** also yields to the new owner directly: when a domain
lapses and someone else buys it, the new owner publishes its
`challenge(tenantId, domain)` record (with `challengeSecret` set) and calls
`add()`. If that same lookup no longer shows the incumbent's record, the domain
is handed over, verified; while the incumbent's record is still published — or
the lookup fails — the claim stands and `add()` throws `DOMAIN_TAKEN`.

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `TenantRequiredError` | `TENANT_REQUIRED` | 400 | `tenantScoped()` / `requireTenantId()` / `requireTenant()` ran with no tenant in context (and, for `requireTenantId`, no explicit fallback) |
| `InvalidTenantIdError` | `TENANT_ID_INVALID` | 400 | `tenancy.create()`, `tenancy.run()`, `provision(id)`, `destroy(id)` (or `MemoryTenantSource.create()/save()`) with an id outside the tenant-id grammar or a reserved id. Nothing is written |
| `TenantResolutionConflictError` | `TENANCY_CONFLICT` | 400 | `onConflict: 'error'` and two resolvers loaded different tenants (e.g. an `x-tenant-id` that disagrees with the `Host`) |
| `TenancyNotResolvedError` | `TENANCY_NOT_RESOLVED` | 404 | `required: true` and no resolver produced a ref that loaded a tenant |
| `CentralOnlyRouteError` | `NOT_FOUND` | 404 | A tenant resolved on a route declared `meta: { tenant: 'never' }`; the body is the plain "route not found" one |
| `TenantNotFoundError` | `TENANT_NOT_FOUND` | 500 | `tenancy.run('unknown-id', …)`, or `forEach()` on a `TenantSource` without `list()` |
| `TenantNotReadyError` | `TENANT_NOT_READY` | **503** | A request resolved to a tenant whose status is `provisioning`, `failed` or `deleting`. 503, not 404: the tenant exists and the client may retry |
| `TenantSuspendedError` | `TENANT_SUSPENDED` | 403 | A request resolved to a tenant whose status is `suspended`. Retrying will not help |
| `TenantStatusUnknownError` | `TENANT_STATUS_UNKNOWN` | 500 | A request resolved to a tenant whose status tenancy does not recognise (`active`, a typo). Store `ready` or no status for a serving tenant |
| `TenantCreateUnsupportedError` | `TENANT_CREATE_UNSUPPORTED` | 500 | `tenancy.create()` on a source implementing neither `create()` nor `save()` — e.g. one backed by a static config file |
| `TenantAlreadyExistsError` | `TENANT_ALREADY_EXISTS` | 409 | `tenancy.create()` (or a source's `create()`) for an id that already exists. Nothing is written. A `failed`/`provisioning` tenant is retried with `tenancy.provision(id)`; an intentional update is `source.save()` |
| `DomainTakenError` | `DOMAIN_TAKEN` | 409 | `domains.add()` for a domain another tenant registered — verified (and its TXT record still published, or no `challenge()` record of yours), or unverified and younger than `claimTtlMs` |
| `DomainNotFoundError` | `DOMAIN_NOT_FOUND` | 404 | `verify` / `instructions` / `remove` for a domain that isn't registered |
| `DomainForbiddenError` | `DOMAIN_FORBIDDEN` | 403 | A tenant acted on a domain belonging to a **different** tenant |
| `DomainReservedError` | `DOMAIN_RESERVED` | 403 | `domains.add()` for a domain in `reservedDomains` or a subdomain of one |
| `InvalidDomainError` | `DOMAIN_INVALID` | 400 | A domain that is not a hostname (userinfo, path, `%`, non-ASCII, IP literal) |
| `MissingCacheScopeError` | `CACHE_SCOPE_MISSING` | 500 | A cache read/write ran with no tenant while tenancy is active — see [Caching](/guide/caching) |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 | `tenantMembershipPlugin` found no membership for the user in the resolved tenant — see [Teams](/guide/teams) |

- **`TENANT_REQUIRED` on a background job or a script** — there is no resolver
  outside a request. Wrap the work in `tenancy.run(tenantId, …)`, or pass the id
  explicitly: `requireTenantId(job.tenantId)`.
- **`TENANT_REQUIRED` on a legitimately central route** (sign-up, landing page,
  platform admin) — those routes shouldn't be calling `tenantScoped()` at all.
  Query the central table deliberately, and declare `meta: { tenant: false }` on
  the route rather than loosening `required` for the whole app — see
  [the multi-tenant pattern](/guide/multi-tenant-pattern#rule-5-—-three-kinds-of-route-declared-in-meta).
- **`TENANCY_NOT_RESOLVED` although the header/subdomain looks right** — the ref
  resolved but the record didn't load. An unknown subdomain or domain ends
  resolution — the header is **not** consulted then — so this is almost always a
  tenant missing from the source (or, with `domainResolver`, a domain that was
  never **verified**), or a header sent to a tenant subdomain that names a
  different tenant. Check with `basalt tenant:list`.
- **`403 TEAM_NOT_A_MEMBER` right after switching tenants** — expected, and the
  point: the tenant resolved, the membership check then refused it. Tenant
  resolution is identification, never authorization — see [Teams](/guide/teams).
- **A custom domain stopped resolving on its own** — a scheduled
  `reverify()` / `reverifyAll()` (or `verify(…, { force: true })`) re-check
  failed and un-verified it. Re-publish the
  `_basalt-verify.<domain>` TXT record.

## Events

| Hook | Payload |
| --- | --- |
| `tenancy:switched` | `{ tenant, via }` — emitted on every entry into a tenant context, by the HTTP enricher (`via: 'http'`) and by `tenancy.run()` (`via: 'run'`) |
| `tenancy:exited` | `{ tenant }` — emitted when a `tenancy.run()` callback settles (resolved or thrown), still inside that tenant's context, so a listener can release what it took on `tenancy:switched` (prismaPlugin returns its leased client). Not emitted for HTTP requests — an enricher returns a disposer for those |
| `tenancy:created` | `{ tenant }` — emitted once a new tenant is created **and provisioned**, so a listener may assume its storage exists. Does not fire if `onProvision` threw |
| `tenancy:destroyed` | `{ tenant }` — emitted by `tenancy.destroy()` after `onDeprovision` ran and the record was deleted from the source |

Durable tenant registries and the per-tenant database options are covered in
[Persistence](/guide/persistence); the end-to-end sign-up flow is in the
[multi-tenant SaaS cookbook](/cookbook/multi-tenant-saas) and
[Creating a tenant](/guide/creating-a-tenant).
