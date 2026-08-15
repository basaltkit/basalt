# Creating a tenant

New to Basalt? Start here. This page teaches **every** way to create a tenant,
from the one-line version you use while trying things out, up to a real sign-up
flow you'd ship to customers. Each section starts with a plain "when to use
this", so you can jump to the level that matches where you are.

## What is a tenant?

A **tenant** is one customer of your app — usually a company or organization —
whose data is kept completely separate from everyone else's. If you build a
project tool used by both "Acme Inc" and "Globex", then Acme is one tenant and
Globex is another. Acme must never see Globex's projects, and the other way
around. That separation is the whole point of multi-tenancy.

A few words you'll meet on this page:

- **Source** — the place your tenants are stored (a list in memory, a database
  table, whatever you choose). Basalt reads tenants *from* a source.
- **Resolving a tenant** — figuring out, for each incoming request, *which*
  tenant it belongs to. Basalt does this by looking at the request (a header, a
  subdomain like `acme.yourapp.com`, or the URL) and matching it to a tenant in
  your source.
- **Membership** — the fact that a specific user belongs to a specific tenant.
  Ada is a *member* of Acme. Membership is what stops a logged-in user from
  peeking into a tenant they don't belong to.

Here's the important idea, and it surprises newcomers: **Basalt does not give
you a ready-made "create tenant" button or route.** Basalt's job is to *resolve*
the active tenant on every request. *Creating* tenants is your app's job,
because only you know when a tenant should exist (a customer signs up, an admin
adds one, you seed a few for a demo). This page shows you how, four ways, from
simplest to most professional.

## Level 1 — In-memory (dev / trying it out)

**When to use this:** you're learning, running tests, or building a quick demo,
and you don't care if the tenants disappear when the app restarts.

The simplest possible source is `MemoryTenantSource`. It keeps tenants in a
plain list in memory. You add a tenant with `.add({ id, ... })` and hand the
source to `tenancyPlugin`. A tenant is just an object — it needs an `id`, and
you can attach any other fields you like (`name`, `plan`, and so on).

This wires up two tenants and lets requests pick one via an `x-tenant-id` header:

```ts
import { tenancyPlugin, MemoryTenantSource, headerResolver } from '@basaltkit/tenancy'

tenancyPlugin({
  source: new MemoryTenantSource()
    .add({ id: 'acme', name: 'Acme Inc' })
    .add({ id: 'globex', name: 'Globex' }),
  resolvers: [headerResolver()], // reads the x-tenant-id header → { id: 'acme' }
})
```

That's the entire "create a tenant" step at this level: `.add(...)`. A request
carrying `x-tenant-id: acme` now runs as Acme.

::: warning Not saved anywhere
`MemoryTenantSource` lives in memory only. Restart the app and every tenant is
gone. That's perfect for tests and demos, and wrong for anything real — for that,
keep reading.
:::

## Level 2 — Native Prisma source (minimal code, production-ready)

**When to use this:** you want tenants that survive restarts and are shared
across every instance of your app, and you already use (or are happy to use) a
SQL database through Prisma. This is the recommended starting point for a real
product, and you write almost no code yourself.

[Prisma](https://www.prisma.io/) is a popular tool for talking to a SQL database
(PostgreSQL, MySQL, …) from TypeScript. Basalt ships a ready-made source,
`PrismaTenantSource`, that stores your tenants in that database. You don't
implement anything — you point it at your database and call `save()`.

**Step 1.** Add two models to your `schema.prisma`. Copy them from
`@basaltkit/tenancy-prisma/schema.prisma` (or run `basalt prisma:sync`), then run
`prisma migrate dev && prisma generate`. `Tenant` stores the tenant record as
JSON; `TenantDomain` lets a tenant claim custom domains like `app.acme.com`:

```prisma
model Tenant {
  id      String         @id
  data    Json           // the open tenant record ({ id, ...anything })
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

**Step 2.** Wrap your generated Prisma client with `prismaTenantSource(...)` and
hand it to `tenancyPlugin` — exactly like Level 1, just a durable source:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaTenantSource } from '@basaltkit/tenancy-prisma'
import { tenancyPlugin, subdomainResolver, domainResolver } from '@basaltkit/tenancy'

const tenants = prismaTenantSource(new PrismaClient())

tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'yourapp.com' }), domainResolver()],
})
```

**Step 3.** Create (or update) a tenant with `save()`. It's an *upsert* — it
inserts the tenant if it's new, or updates it if the `id` already exists. Any
extra field you pass is stored and comes back unchanged:

```ts
await tenants.save({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })
```

That's it. The tenant is now in your database, `acme.yourapp.com` (or the custom
domain `app.acme.com`) resolves to it, and it's still there after a restart.

::: tip Domains must be unique
`save()` replaces the tenant's set of custom domains. If a domain is already
owned by a *different* tenant, `save()` refuses — routing has to be unambiguous.
:::

## Level 3 — Your own tenant repository

**When to use this:** your tenants already live in a table you designed, with
your own columns, and you'd rather read them straight from there than copy them
into Basalt's `Tenant` table.

A **source** is defined by a small interface called `TenantSource`. You can
implement it yourself over any storage. Only one method is required:

- `find(id)` — return the tenant with this id, or `null`. **Required.**
- `findByDomain(domain)` — return the tenant that owns a custom domain, or
  `null`. Optional; only needed if you use `domainResolver()`.
- `list()` — return every tenant. Optional; only needed for bulk jobs like
  `tenancy.forEach()`.

Here's a compact source over your own `organization` table. `find` reads a row
and shapes it into a tenant object; `save` is your own helper for creating one:

```ts
import type { TenantSource, Tenant } from '@basaltkit/tenancy'
import { db } from './db' // your own database access

export const orgSource: TenantSource = {
  async find(id): Promise<Tenant | null> {
    const org = await db.organization.findUnique({ where: { id } })
    return org ? { id: org.id, name: org.name, plan: org.plan } : null
  },
  async list(): Promise<Tenant[]> {
    const orgs = await db.organization.findMany()
    return orgs.map((o) => ({ id: o.id, name: o.name, plan: o.plan }))
  },
}

// Your own "create a tenant" — write to your own table however you like:
export async function createOrg(input: { id: string; name: string }) {
  await db.organization.create({ data: input })
  return input
}
```

Pass `orgSource` to `tenancyPlugin` just like the others. The lesson: a source
is a tiny contract, so Basalt never dictates your schema. Reach for this when the
native sources don't fit your existing data.

## Level 4 — Professional onboarding flow

**When to use this:** you're building a real product. A customer signs up, a
tenant is created for them, and *they* become its first owner — all in one
request.

This is the grown-up version. A single `POST /onboarding` route does four things:

1. **Requires a logged-in user.** No anonymous tenant creation. Auth puts the
   user on the request as `ctx().user`.
2. **Persists the tenant** in your durable source (Level 2 or 3).
3. **Makes the creator the owner** via `teams.addMember(tenantId, userId, 'owner')`
   — so from the very first moment there's a real membership linking this user to
   this tenant. (`@basaltkit/teams` manages who belongs to a tenant and their
   role: `owner`, `admin`, or `member`.)
4. **Lets later requests find the tenant.** Because the record now exists in the
   source, the resolver you already configured (subdomain, domain, …) routes the
   new tenant's traffic automatically — nothing extra to wire per tenant.

Here's the service function that creates the tenant and seeds its owner:

```ts
import { TEAMS } from '@basaltkit/teams'
import { tenants } from './tenancy' // your durable source from Level 2/3

export async function onboard(app, userId: string, input: { id: string; name: string }) {
  // 2. persist the tenant so resolvers can route to it from now on
  await tenants.save({ id: input.id, name: input.name })

  // 3. the creator becomes the tenant's first owner
  await app.container.get(TEAMS).addMember(input.id, userId, 'owner')

  return { id: input.id, name: input.name }
}
```

And here's the route that requires a signed-in user and calls it. `meta.auth`
tells Basalt this route needs authentication; `ctx().user` is the logged-in user:

```ts
import { route } from '@basaltkit/fastify'
import { ctx } from '@basaltkit/core'
import { onboard } from './onboarding'

route({
  method: 'POST',
  url: '/onboarding',
  meta: { auth: true }, // 1. reject anonymous callers
  async handler(req) {
    const user = ctx().user           // set by @basaltkit/auth
    const { id, name } = req.body as { id: string; name: string }
    return onboard(req.server.app, user.id, { id, name })
  },
})
```

After this call, `acme.yourapp.com` resolves to the new tenant, and the user who
created it is already its `owner` — ready to invite teammates (see
[Teams](/guide/teams)).

## Security: never trust a client-supplied tenant

::: warning Verify membership before trusting a tenant id
Resolving a tenant from a header or subdomain is convenient, but a request is
**attacker-controlled**. If you read `x-tenant-id: acme` and scope to `acme`
without checking that the logged-in user actually belongs to `acme`, then *any*
logged-in user can read *another* tenant's data. Always confirm membership with
`teams.can(...)`:

```ts
// After the tenant is resolved, before you trust it:
if (!(await teams.can(tenantId, ctx().user.id, 'member'))) {
  throw new ForbiddenError()
}
```

Bind tenant selection to a **verified user↔tenant membership**, never to the raw
request alone. See [Security](/guide/security) for the full picture.
:::

## Which should I use?

| Your situation | Use this | How you create a tenant |
| --- | --- | --- |
| Learning, tests, a quick demo | `MemoryTenantSource` | `.add({ id, name })` |
| A real product, simplest path | `PrismaTenantSource` (`@basaltkit/tenancy-prisma`) | `source.save({ id, name })` |
| Tenants already in your own table | Your own `TenantSource` | your own insert + `find`/`list` |
| Real sign-up, creator becomes owner | Onboarding route + `@basaltkit/teams` | `POST /onboarding` → `save` + `addMember(..., 'owner')` |

Start at Level 1 to learn, move to Level 2 the moment you need tenants to
survive a restart, and add Level 4 when you have real customers signing
themselves up.
