# The multi-tenant pattern

One app, one auth stack, **two planes**: the central plane where the SaaS is
operated, and one tenant plane per customer. Every request lands in exactly one
of them, and everything else — which users exist, which roles apply, which
tables a query can reach — follows from that.

This page is the pattern the framework was built for, written as ten rules you
can check a codebase against. It is not a tutorial: the [tenancy](/guide/tenancy),
[database-per-tenant](/guide/database-per-tenant) and
[creating a tenant](/guide/creating-a-tenant) guides teach each piece. This one
tells you how the pieces have to fit, and what goes wrong when they do not. The
rules come from auditing three production apps built on Basalt, and every
"what goes wrong" below is something one of them actually shipped.

[[toc]]

## The shape in one picture

```
  app.example.com  ──── central plane ────►  public.*          (SaaS staff, tenants register, billing)
  acme.example.com ──── tenant plane  ────►  tenant_acme.*     (Acme's users, Acme's data)
  globex.example.com ── tenant plane  ────►  tenant_globex.*   (Globex's users, Globex's data)

  one PostgreSQL · one authPlugin · one permissionsPlugin · db() picks the plane
```

The isolation is the connection. A tenant schema has its own `auth_users`, its
own `perm_*` tables and its own domain tables, so a query on Acme's host cannot
reach Globex's rows without naming the schema on purpose. The central plane holds
only what the operator of the SaaS owns: the tenant register, plans,
subscriptions, payments, the staff accounts and their roles.

## Rule 1 — One PostgreSQL, one schema per tenant

```ts
import { prismaPlugin } from '@basaltkit/prisma'
import { PrismaClient as CentralClient } from '../generated/central'
import { PrismaClient as TenantClient } from '../generated/tenant'

export const central = new CentralClient()

prismaPlugin({
  client: central,                                   // the central plane
  schemaPerTenant: {                                 // the tenant planes
    url: env.DATABASE_URL,
    createClient: (url) => new TenantClient({ datasourceUrl: url }),
  },
  destroy: (client) => client.$disconnect(),
  max: 20,
})
```

`client` is the plane a request with no tenant lands in. `schemaPerTenant` is the
plane a request with a tenant lands in. `db()` returns whichever applies. No app
model carries a `tenantId`, no query filters by it, and no row-level security is
needed: the schema *is* the tenant.

`forTenant: (id) => createTenantDb(url, id)` is an accepted equivalent when your
factory pins the schema through both the adapter `{ schema }` and the connection's
`search_path`. Pin it in one place only and every unqualified table name in raw
SQL depends on it.

::: details When to choose shared-database mode instead
One database with `tenantId` on every model and `tenancyExtension()` on the app
client is simpler to operate and fine for many products. The trade is that the
framework's own tables — `auth_users`, `perm_*`, `tenants` — do not carry a
`tenantId`, so the stores get the **unscoped** client and identity becomes
global: one account across tenants, access by membership. That is a different
identity model, not a lighter version of this one. Everything below assumes the
per-schema model; the [database-per-tenant](/guide/database-per-tenant) guide
covers the shared-database wiring.
:::

## Rule 2 — Two Prisma schemas, two generators, two clients

```
prisma/
  schema.prisma              → generated/central   Auth*, Perm*, Team*, Tenant, TenantDomain,
                                                   Plan, Subscription, Payment, PlatformSettings
  prisma.config.ts
  tenants/
    schema.prisma            → generated/tenant    Auth*, Perm*, Team*, AuditEntry, + your domain
    prisma.config.ts
    migrations/
```

Two generators with two `output` paths, not one schema with both planes' models.
With one client the central database grows every tenant table, empty forever,
and an empty table in the wrong plane is exactly where a stray write lands
unnoticed. Two clients also give you two types, `CentralDb` and `TenantDb`, so
the compiler refuses `centralDb().invoice` before a test would.

The tenant history is migrated per schema with
[`migrateTenants`](/guide/database-per-tenant#migrating-every-tenant) and the
tenant `prisma.config.ts`. The central history is ordinary `prisma migrate deploy`.

## Rule 3 — Resolve by host, register with one reserved list

```ts
import { tenancyPlugin, subdomainResolver, domainResolver, headerResolver, isValidTenantId } from '@basaltkit/tenancy'
import { prismaTenantSource } from '@basaltkit/tenancy-prisma'
import { isReservedSlug } from './tenancy/reserved'

tenancyPlugin({
  source: prismaTenantSource(central),
  resolvers: [
    subdomainResolver({ base: env.APP_BASE_HOST }),   // acme.example.com
    domainResolver(),                                 // verified custom domains
    ...(env.NODE_ENV === 'test' ? [headerResolver()] : []),
  ],
  required: true,
  validateTenantId: (id) => isValidTenantId(id) && !isReservedSlug(id),
  canonicalDomain: (tenant) => `${tenant.id}.${env.APP_BASE_HOST}`,
})
```

Three decisions hide in that block.

**The header resolver is a test fixture.** `x-tenant-id` lets a test pick any
tenant without DNS. It also lets any client pick any tenant, so it never runs
outside `NODE_ENV === 'test'`. "Not production" is not the same condition:
staging runs with other values and inherits the door.

**One reserved list.** `www`, `app`, `api`, `admin`, `central`, `platform`,
`mail`, `static`, `docs`, `status` — whatever names your apex, your API host and
your marketing pages use. The framework only reserves `global`. Put the list in
one module and use it in three places: `validateTenantId` (so `tenancy.create()`
refuses it), the sign-up validator (so the user gets a 400, not a 500) and the
subdomain resolver if you wrap it. Two lists drift: we found one where sign-up
allowed `central` and the plan schema did not.

**`canonicalDomain` on the plugin, not at the call site.** The tenant's own
`<id>.<base>` domain is added by `tenancy.create()` itself. Wrapping every call
to `create()` by hand is the version that gets forgotten on the third call site.

## Rule 4 — Stores are built once, over `tenantClient()`

```ts
import { tenantClient, db } from '@basaltkit/prisma'
import { requireTenantId } from '@basaltkit/tenancy'

// Built at boot, resolved per request: auth, permissions, teams, audit,
// notifications — everything that exists in BOTH planes.
export const tenantDb = tenantClient<TenantDb>()

const authStores = prismaAuthStores(tenantDb)
const access = prismaAccessStore(tenantDb).store
const teams = prismaTeamsStores(tenantDb)

// Bound to the CENTRAL client explicitly: things that exist in ONE plane.
const tenants = prismaTenantSource(central)
const centralAccess = prismaAccessStore(central).store
const subscriptions = prismaSubscriptionsStores(central)
```

And two helpers that every handler goes through instead of calling `db()`:

```ts
/** The tenant plane. Throws TENANT_REQUIRED when no tenant resolved. */
export function tenantDb(): TenantDb {
  requireTenantId()
  return db<TenantDb>()
}

/** The central plane. REFUSES a request that resolved a tenant. */
export function centralDb(): CentralDb {
  if (ctx().tenant) throw new HttpError(404, 'Not found')
  return central
}
```

The second helper is the one people leave out. `meta: { tenant: false }` lifts the
*requirement* for a tenant; it does not stop resolution. A platform route
reached on `acme.example.com/platform/...` still has `ctx().tenant` set to Acme,
and a `centralDb()` that simply returns `central` is now the only thing between
Acme's owner and the operator's tables. Rule 5 closes the route; this closes the
data path. Keep both.

::: danger Never fall back to the central plane
`try { return db() } catch { return central }` is the most dangerous line we
found in any of the three apps. It was in a search adapter: whenever a hook ran
outside a request, index writes silently landed in the central schema. Every
framework store fails closed — `db()` throws `DB_UNAVAILABLE` — and a wrapper
that catches that and picks a plane on its own undoes the guarantee for
everything behind it. If a caller legitimately needs the central plane, give it
an instance bound to `central`.
:::

## Rule 5 — Three kinds of route, declared in `meta`

| Kind | Declares | Reached on | Examples |
| --- | --- | --- | --- |
| Tenant route (default) | nothing | tenant host only | invoices, documents, team |
| Account route | `tenant: false` | apex **and** tenant hosts | `authRoutes()`, `mfaRoutes()`, invite acceptance |
| Platform route | `tenant: false, platform: true, auth: true, can: 'platform:…'` | apex only | tenant approval, plans, operator roles |

Account routes are the interesting case. `POST /auth/login` on the apex
authenticates against `public.auth_users`; the same route on `acme.example.com`
authenticates against `tenant_acme.auth_users`, because the auth stores follow
`db()`. One route, two planes, no branching. The framework marks these with
`meta.account`, which the teams membership guard honours; wrap them once so they
also carry `tenant: false`:

```ts
const central = (r: RouteDef) => ({ ...r, meta: { ...r.meta, tenant: false } })
routes: [...authRoutes().map(central), ...mfaRoutes().map(central), ...appRoutes]
```

Platform routes need a guard the framework does not ship, because `platform` is
your key, not its:

```ts
// src/platform/guard.ts — registered like any other guard
const platformOnly: RouteGuard = async ({ route, context }) => {
  if (route.meta?.['platform'] !== true) return
  if (context.tenant) throw new HttpError(404, 'Not found')
}
metadata.add('http:guards', platformOnly)
```

Why 404 and not 403: on a tenant host the platform console does not exist. A 403
tells Acme's owner there is something there to be forbidden from.

::: warning Wildcards reach further than you think
A tenant `owner` role granted `'*'` satisfies `can: 'platform:tenants:approve'`.
Inside the tenant plane that is harmless — the central tables are not there —
until a platform route is served on a tenant host without the guard above. We
found this chain complete in one app: owner on own subdomain → `platform:*`
matched by `*` → `centralDb()` returned the tenant client → an operator-role
write landed in the tenant schema and its audit entry in the **central** chain.
The guard is what breaks the chain; prefixing platform permissions is hygiene,
not protection.
:::

Registration on tenant hosts is closed: people join a tenant by invitation, not
by finding its subdomain. Return 404 from `/auth/register` when a tenant resolved.
Registration on the apex is either closed too (staff are created from the CLI)
or open but unprivileged — an apex account with no platform role can do nothing.

## Rule 6 — One identity stack, two populations

The people who operate the SaaS and the people inside each customer are
different populations. Same e-mail in both places is two people. A central
account never opens a tenant, and a tenant account never opens the console.

That separation costs nothing: it is what Rule 4 already gives you. `authPlugin`
on `tenantDb` puts staff in `public.auth_users` and customers in each
`tenant_<id>.auth_users`; a session issued on the apex is looked up in the
central table and finds nothing on a tenant host. Two of the three apps we
audited had exactly this, with tests proving a central cookie is a 401 on a
tenant and vice versa.

The third had written a `PlatformOperator` model with its own scrypt hashing,
its own session table, its own cookie, CSRF, lockout and encrypted TOTP. It
worked. It was also a second security-critical codebase, tested less than the
first, and the operators it protected — the people with the most power — were
the ones with the fewest of the framework's protections. The
[anti-pattern box](/guide/database-per-tenant#the-central-plane-is-not-a-second-identity-system)
in the database-per-tenant guide is that app.

Two corollaries:

- **Users are created through `AUTH`, never by hashing and inserting.** A
  sign-up flow that writes `authUser.create({ passwordHash })` by hand skips
  the password policy, the token version and every hook a later feature relies on.
- **MFA policy covers the central plane.** A policy that starts with
  `if (!ctx().tenant) return` protects every customer and no operator. Express
  it once through `authPlugin({ requireMfa })` and make it answer for platform
  roles too.

## Rule 7 — One permissions system, scoped by plane

```ts
import { GLOBAL_SCOPE } from '@basaltkit/permissions'

// Tenant roles: seeded in the TENANT scope, inside provisioning.
onProvision: async (tenant) => {
  await provisionTenantSchema(central, tenantSchema(tenant.id))
  await migrateTenants({ tenants: [tenant.id], /* … */ })
  await seedRoles(access, tenant.id)            // partner, admin, member, … under tenant.id
}

// Platform roles: granted in GLOBAL_SCOPE, through the CENTRAL access store.
await centralAccess.grantToRole('platform_admin', ['platform:tenants:approve', 'platform:read'], GLOBAL_SCOPE)
```

Roles live where the data lives. A tenant's roles are rows in that tenant's
`perm_*` tables under the tenant's id; the platform's roles are rows in
`public.perm_*` under `GLOBAL_SCOPE`. Because the schemas are separate, a
`@global` grant in the central plane is invisible inside every tenant — which is
the behaviour you want, and the opposite of shared-database mode, where a global
grant applies everywhere.

`GLOBAL_SCOPE` is imported, never spelt. It is `'@global'`; the pre-1.5 string
`'global'` is a reserved value the Gate no longer reads, so a grant written under
it is a grant that never applies. See
[the global scope can't be a tenant](/guide/authorization#the-global-scope-can-t-be-a-tenant).

Routes say `can:`. Handlers do not say `if (roles.includes('owner'))`. One app
had nine such checks scattered through services; each is a permission that the
catalogue does not know about and the console cannot revoke. When a decision is
really about the role and not a permission — "the last owner cannot demote
themselves" — keep it, and keep it rare.

If app code needs the current scope outside a route, it needs it in one place:

```ts
export const currentScope = () => ctx().tenant?.id ?? GLOBAL_SCOPE
```

Seven copies of that line is seven places to get the fallback wrong.

## Rule 8 — The first accounts come from the CLI and from provisioning

**First platform administrator.** An app command, because the framework cannot
know your role names:

```ts
// src/platform/commands.ts — registered with commandsPlugin
{
  name: 'platform:admin',
  args: ['email'],
  run: async ({ email }) => {
    const user = await centralAuth.users.findByEmail(email)   // an EXISTING central account
    if (!user) throw new Error(`no central account for ${email}; register on the apex first`)
    await centralAccess.assignRole(user.id, 'platform_admin', GLOBAL_SCOPE)
  },
}
```

Not a route: the first admin has nobody to authorise them, and an unprotected
"create the first admin" endpoint is the one that stays open. Not an environment
variable with a bootstrap password either: it ends up in a deployment file, and
whoever reads the file is an operator. Whoever can run a command on the server
already has the database.

**First tenant owner.** Created *inside the tenant plane*, at the moment the
tenant becomes ready:

```ts
const tenant = await tenancy.create({ id: slug, name })         // provisions the schema
await tenancy.run(tenant.id, async () => {
  const owner = await auth.register({ email, password })        // lands in tenant_<slug>.auth_users
  await access.assignRole(owner.id, 'owner', tenant.id)
  await teams.addMember(tenant.id, owner.id, 'owner')
})
```

The person who signed up on the apex may also keep a central account — for
billing, for seeing all the companies they own — but that is a second account
by design, linked by an id in the tenant record, not the same row.

## Rule 9 — Outside a request, the tenant is explicit

```ts
await tenancy.run(tenantId, () => reindex())          // one tenant
await tenancy.forEach((tenant) => sendReminders())     // every tenant, in context
```

Jobs carry `tenantId` in their payload and restore it with `tenancy.run` before
touching `db()`; the queue integration does this for you. Scripts and CLI
commands take `--tenant` and do the same. Nothing opens its own
`new TenantClient(url)` outside the plugin's pool: it bypasses the connection
ceiling, the `destroy` hook and every `tenancy:switched` listener.

A loop over tenants skips the ones that are not `ready`. A suspension check that
only fires when a request id exists protects the HTTP surface and leaves every
background job relaying data for a suspended customer.

## Rule 10 — The isolation tests

A multi-tenant app without these tests is a multi-tenant app whose isolation is
a belief. Each one takes ten lines with `@basaltkit/testing`.

1. A token issued on tenant A, presented on tenant B's host → 401.
2. The same e-mail registered on A and on B → two accounts, two ids.
3. A host that resolves to no tenant → 404.
4. A central session on a tenant host → 401. A tenant session on the apex → 401.
5. A tenant owner calling a platform route on their own host → 404.
6. `public` contains none of the tenant-content tables (assert at boot too).
7. For at least one domain module: A cannot read, update or delete B's rows,
   and deleting a user in A leaves B intact.

The fifth one is the test none of the three apps had, and the one that would
have caught the chain in Rule 5.

## Checklist

Paste this into the pull request that introduces tenancy, and again into the
one that adds the platform console.

- [ ] `prismaPlugin({ client: central, schemaPerTenant | forTenant })` — two planes
- [ ] two `schema.prisma`, two generators, two client types
- [ ] resolvers: subdomain, domain; header only under `NODE_ENV === 'test'`
- [ ] `required: true`; `meta.tenant: false` only on account and platform routes
- [ ] one reserved-slug module used by `validateTenantId` and by sign-up
- [ ] `canonicalDomain` set on the plugin
- [ ] every both-plane store built over `tenantClient()`; every central store bound to `central`
- [ ] `tenantDb()` requires a tenant; `centralDb()` refuses one
- [ ] no `catch { return central }` anywhere
- [ ] platform routes declare `platform: true` and a guard 404s them on a tenant host
- [ ] `/auth/register` is 404 on tenant hosts
- [ ] one `authPlugin`; no operator model, no second session table
- [ ] users created through `AUTH`, never inserted with a hand-made hash
- [ ] MFA policy answers for platform roles
- [ ] tenant roles seeded under the tenant id in `onProvision`; platform roles under `GLOBAL_SCOPE` (imported) via the central store
- [ ] `can:` on routes; role-name checks justified in a comment
- [ ] `platform:admin <email>` CLI command; no bootstrap route, no bootstrap env password
- [ ] first owner created inside `tenancy.run` at provisioning
- [ ] background work uses `tenancy.run` / `forEach`, skips non-ready tenants, opens no ad-hoc clients
- [ ] the seven isolation tests

## What this pattern does not decide

These are yours, and the framework has no opinion beyond the hooks it gives you:

- **Tenant deletion.** `tenancy.destroy()` runs `onDeprovision` in the tenant's
  context; dropping the schema, purging storage and search, and what the audit
  trail keeps are your policy.
- **Suspension.** A `status` on the tenant record plus a `tenancy:switched`
  listener that refuses it. Decide whether background work continues.
- **Support access.** An operator acting inside a tenant is a tenant session
  created for them by an audited platform route, never a central session that
  the membership guard was told to exempt.
- **Billing ownership.** Plans, subscriptions and payments are central-plane
  data keyed by tenant id; the tenant plane reads its entitlements, never writes them.
