<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/tenancy

Multi-tenancy for Basalt applications: automatically identifies which customer (tenant) each request belongs to — by subdomain, custom domain, header, or route — and makes it available at `ctx().tenant` throughout the application.

You need this module when the same application serves multiple customers/organizations with separate data (the typical SaaS model).

## What this module solves

**Multi-tenancy** means a single application deployment serves several "tenants" — companies, teams, or organizations — each with its own data, like a building where each unit has its own key. The challenge is: when an HTTP request arrives, how does the application know which tenant it belongs to? And how do you ensure the code that runs afterward always "knows" which tenant it's in, without passing that value from function to function?

This module solves both parts. First, the **resolvers**: small functions that look at the request and identify the tenant — by subdomain (`acme.myapp.com` → tenant `acme`), by a customer's own domain (`app.acme.com`), by a header (`x-tenant-id`), or by a route parameter (`/t/acme/...`). You can combine several: the first one to find an existing tenant wins.

Second, the **context**: once resolved, the tenant is placed in `ctx().tenant` (using Node's AsyncLocalStorage — an "invisible thread" that follows each request), accessible in any handler, service, or hook without passing arguments. You can also run code "as" a tenant outside an HTTP request (jobs, migrations) with `tenancy.run()`, and iterate over all tenants with `tenancy.forEach()`.

## Installation

```bash
pnpm add @basaltkit/tenancy
```

## Get started in 5 minutes

1. **Define where tenants come from** (in production, your database; for experimenting, memory):

```ts
import { MemoryTenantSource } from '@basaltkit/tenancy'

const source = new MemoryTenantSource()
  .add({ id: 'acme', name: 'Acme Inc' })
  .add({ id: 'globex', name: 'Globex' })
```

2. **Register the plugin with a resolver:**

```ts
import { createApp, ctx } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { tenancyPlugin, headerResolver, MemoryTenantSource } from '@basaltkit/tenancy'

const source = new MemoryTenantSource().add({ id: 'acme', name: 'Acme Inc' })

const app = await createApp({
  plugins: [
    tenancyPlugin({
      source,
      resolvers: [headerResolver()], // reads the x-tenant-id header
    }),
    fastifyPlugin({
      routes: [
        route({
          method: 'GET',
          url: '/whoami',
          async handler() {
            return { tenant: ctx().tenant?.id ?? null }
          },
        }),
      ],
    }),
  ],
}).boot()
```

3. **Test it:**

```bash
curl http://localhost:3000/whoami -H 'x-tenant-id: acme'
# → { "tenant": "acme" }

curl http://localhost:3000/whoami
# → { "tenant": null }  (request with no tenant — allowed, because required is false)
```

4. **To always require a tenant**, pass `required: true` — unresolved requests get a 404 `TENANCY_NOT_RESOLVED`.

## Usage guide

### Choosing the resolver

```ts
import {
  subdomainResolver, domainResolver, headerResolver, routeResolver,
} from '@basaltkit/tenancy'

// acme.myapp.com → tenant "acme" (ignores www, the base domain, and nested subdomains)
subdomainResolver({ base: 'myapp.com' })

// Customer's own domain: app.acme.com → source.findByDomain('app.acme.com')
domainResolver()

// HTTP header (default x-tenant-id; customizable)
headerResolver({ header: 'x-org' })

// Route parameter: /t/:tenant/... (default 'tenant')
routeResolver({ param: 'tenant' })
```

You can pass several in `resolvers: [...]` — they're tried in order, and the first whose reference matches an **existing** tenant in the source wins (a reference to an unknown tenant falls through to the next one).

### Connecting to your database (TenantSource)

```ts
import type { TenantSource, Tenant } from '@basaltkit/tenancy'

const source: TenantSource = {
  async find(id) { /* SELECT ... WHERE id = ? */ return null },
  // Optional — required for domainResolver():
  async findByDomain(domain) { /* SELECT ... WHERE domain = ? */ return null },
  // Optional — required for tenancy.forEach():
  async list() { return [] },
}
```

The `Tenant` type only requires `id: string`; add whatever fields you want (`name`, `plan`, `domains`, …). Note: `MemoryTenantSource`'s `findByDomain` looks up the tenant's `domains: string[]` field.

### Running code as a tenant (jobs, scripts)

Outside an HTTP request there's no resolver — use the `Tenancy` facade:

```ts
import { TENANCY } from '@basaltkit/tenancy'
import { ctx } from '@basaltkit/core'

const tenancy = app.container.get(TENANCY)

// Runs the function with ctx().tenant = acme (outer context preserved and restored)
await tenancy.run('acme', async () => {
  console.log(ctx().tenant?.id) // 'acme'
})

// Bulk maintenance: visits every tenant, each in its own context,
// with limited concurrency (default 5)
await tenancy.forEach(
  async (tenant) => { /* e.g. run the tenant's migrations */ },
  { concurrency: 2 },
)
```

`run()` accepts either the `Tenant` object or the `id` (which is loaded from the source; if it doesn't exist, it throws `TenantNotFoundError`).

### Fail-closed scoping — `tenantScoped()` and friends

Identifying the tenant is only half the job; every query still has to *use* it.
The risk is specific and silent: with Prisma,
`where: { tenantId: undefined }` doesn't filter — it drops the condition and
returns **every** tenant's rows. A helper that returns `undefined` when there is
no tenant is therefore a cross-tenant leak waiting for one missing context.

The `tenantScoped()` family fails closed instead. All three throw
`TenantRequiredError` (`TENANT_REQUIRED`, HTTP **400**) rather than producing a
filter that quietly disappears:

```ts
import { requireTenant, requireTenantId, tenantScoped } from '@basaltkit/tenancy'

// The whole Tenant record, or throw
const tenant = requireTenant()

// Just the id, or throw
const id = requireTenantId()

// A `where` clause that is always scoped
const rows = await db.project.findMany({ where: tenantScoped({ archived: false }) })
// → { archived: false, tenantId: '<context tenant>' }
```

| Function | Signature | Behaviour |
|---|---|---|
| `requireTenant()` | `(): Tenant` | The active context's tenant, or throws. |
| `requireTenantId(fallback?)` | `(fallback?: string): string` | The context tenant id; else `fallback`; else throws. |
| `tenantScoped(where?)` | `<W>(where?: W): W & { tenantId: string }` | Your `where` with `tenantId` spread **last**. |

Two properties matter:

**Anti-widening.** A tenant in context always wins over `fallback`. `fallback`
may carry client input, and it must never be able to widen or switch the scope
of a request. It is honoured only when there is no context tenant at all — which
is what lets system code (jobs, CLI commands) pin one tenant deliberately.

**Non-overridable filter.** `tenantScoped` spreads `tenantId` **last**, so a
`tenantId` smuggled into `where` by client input cannot override the context
tenant. (When there is no context tenant, a string `where.tenantId` is used as
the `fallback` — the same anti-widening rule, one level down.)

Use them everywhere a repository touches tenant-owned data. `requireTenantId()`
inside a queue job throws unless you wrapped the job body in
`tenancy.run(tenantId, …)` — which is the point: a background job that lost its
tenant should fail, not read the whole table.

### Reacting to tenant changes (hook)

Whenever execution enters a tenant context (in a resolved HTTP request or via `run`), the `tenancy:switched` hook fires:

```ts
app.hooks.on('tenancy:switched', ({ tenant }) => {
  console.log('working for tenant', tenant.id)
})
```

### CLI commands (`basalt tenant:*`)

Registering `tenancyPlugin` wires five CLI commands (run via the `@basaltkit/cli` runner):

```bash
basalt tenant:list                          # every tenant (needs source.list)
basalt tenant:create acme --name=Acme       # needs source.create
basalt tenant:migrate                       # run onMigrate for every tenant…
basalt tenant:migrate --tenant=acme         # …or just one
basalt tenant:seed --tenant=acme            # run onSeed inside the tenant context
basalt tenant:run acme queue:stats          # run ANY command as that tenant
```

`tenant:migrate` / `tenant:seed` run the per-tenant hooks you pass to the plugin —
you own the DB-specific work, the framework iterates tenants and enters each
context for you:

```ts
tenancyPlugin({
  source, resolvers,
  onMigrate: (tenant) => runPrismaMigrateFor(tenant),
  onSeed:    (tenant) => seedDefaultsFor(tenant),
})
```

`tenant:run <id> <command> [args]` resolves any plugin-registered command and runs
it inside `<id>`'s context — e.g. `basalt tenant:run acme queue:retry`.

## API reference

### `tenancyPlugin(options)`

| Name | Type | Required? | Default | Description |
|---|---|---|---|---|
| `source` | `TenantSource` | Yes | — | Where tenants are loaded from. |
| `resolvers` | `TenantResolver[]` | Yes | — | Tried in order; the first one that loads a tenant wins. |
| `required` | `boolean \| { except: (string \| RegExp)[] }` | No | `false` | `true` → a request with no tenant gets a 404 `TENANCY_NOT_RESOLVED`. `{ except: ['/health'] }` exempts those paths (matched without the query string) and guards everything else. |

A route can override `required` for itself with `meta.tenant` — `false` marks it central, `true` requires a tenant even when the app-wide default is off:

```ts
route({ method: 'GET', url: '/pricing', meta: { tenant: false }, handler })
```

| `onMigrate` | `(tenant: Tenant) => void \| Promise<void>` | No | — | Per-tenant migration work for `basalt tenant:migrate`. The framework iterates tenants and enters each context; you do the DB-specific part. Without it the command errors. |
| `onSeed` | `(tenant: Tenant) => void \| Promise<void>` | No | — | Per-tenant seeding for `basalt tenant:seed`, same contract. |

The plugin also adds the `tenancy:active` marker to the container metadata.
Other packages read it — string-keyed, so no package coupling — to adopt
tenant-safe defaults; `@basaltkit/cache`, for example, fails closed on a missing
tenant scope once the app is known to be multi-tenant.

The plugin registers the facade in the container under the `TENANCY` token, and an HTTP enricher that resolves the tenant for each request, places it in `ctx().tenant`, and emits `tenancy:switched`.

### `Tenancy` class

Constructor: `new Tenancy(source, resolvers, hooks?)` (normally created by the plugin).

| Method | Returns | Description |
|---|---|---|
| `current()` | `Tenant \| undefined` | The tenant of the active context. |
| `find(id)` | `Promise<Tenant \| null>` | Looks it up in the source. |
| `resolve(request)` | `Promise<Tenant \| null>` | Runs the resolvers over `{ headers?, params?, url? }`. |
| `run(tenantOrId, fn)` | `Promise<T>` | Runs `fn` with `ctx().tenant` set; emits `tenancy:switched`. |
| `forEach(fn, { concurrency? })` | `Promise<void>` | Runs `fn` for each tenant (requires `source.list`); default concurrency 5. |

### Resolvers

| Function | Options | Returns |
|---|---|---|
| `subdomainResolver(options)` | `base: string` (required) | `{ id: subdomain }`; ignores `www`, the base domain, nested subdomains, and the port. |
| `domainResolver()` | — | `{ domain: host }`; requires `source.findByDomain`. |
| `headerResolver(options?)` | `header?: string` (default `'x-tenant-id'`) | `{ id: headerValue }`. |
| `routeResolver(options?)` | `param?: string` (default `'tenant'`) | `{ id: params[param] }`. |

A `TenantResolver` is `(request: ResolutionRequest) => TenantRef | null | Promise<...>`, where `TenantRef` is `{ id: string }` or `{ domain: string }`. You can write your own — it's just a function. (Advanced.)

### Types and errors

| Export | Description |
|---|---|
| `Tenant` | `{ id: string; [key: string]: unknown }`. |
| `TenantSource` | `find` (required), `findByDomain?`, `list?`. |
| `MemoryTenantSource` | In-memory source with a chainable `.add(tenant)` — dev/tests. |
| `ResolutionRequest`, `TenantRef`, `TenantResolver` | Resolver types. Advanced. |
| `TENANCY` | Injection token: `container.get(TENANCY)` → `Tenancy`. |
| `requireTenant`, `requireTenantId`, `tenantScoped` | Fail-closed scoping helpers — see above. |
| `CustomDomains`, `MemoryDomainStore`, `DomainStore`, `CustomDomain`, `DnsVerification`, `CustomDomainsOptions` | Custom-domain registration + DNS TXT ownership verification. |
| `normalizeDomain(input)` | Canonicalizes a domain/Host: lowercase, trim, strip port and trailing dots, IDNA-encode. The same function backs registration, lookup and the Host resolver, so a domain keys identically however it was typed. |
| `findByVerifiedDomain(customDomains, find)` | Builds a `findByDomain` that resolves **only verified** domains — wire it into your `TenantSource` so a forged Host header can never resolve. |

### Custom domains

`CustomDomains` adds ownership proof around the domain resolver: register a
domain (unverified), publish the returned `_basalt-verify.<domain>` TXT record,
then `verify()`. Only verified domains resolve, via `findByVerifiedDomain`.
`verify(tenantId, domain, { force: true })` re-checks an already-verified domain
and **un-verifies** it if the record is gone — run it on a schedule to defend
against dangling-domain takeover.

`CustomDomainsOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `store` | `DomainStore` | `MemoryDomainStore` | Where domain records live. A durable store **must** back `add()` with a UNIQUE constraint — it is the atomic uniqueness gate that stops a second tenant stealing a domain. |
| `now` | `() => number` | `Date.now` | Injectable clock. |
| `token` | `() => string` | 24 random bytes, base64url | Verification-token generator. |
| `resolveTxt` | `(hostname) => Promise<string[][]>` | `node:dns/promises` `resolveTxt` | Injectable DNS lookup (tests, or a custom resolver). |

### Failure modes & troubleshooting

| Error | Code | HTTP | When |
|---|---|---|---|
| `TenantRequiredError` | `TENANT_REQUIRED` | 400 | `requireTenant()` / `requireTenantId()` / `tenantScoped()` ran with no tenant in context and no fallback. Fails closed rather than querying unscoped. |
| `TenancyNotResolvedError` | `TENANCY_NOT_RESOLVED` | 404 | No resolver produced a tenant and the plugin was configured `required: true`. |
| `TenantNotFoundError` | `TENANT_NOT_FOUND` | 500 | `run()` was given an id absent from the source — also raised by `forEach()` when the source has no `list()`. |
| `DomainTakenError` | `DOMAIN_TAKEN` | 409 | The domain is already registered (by any tenant). |
| `DomainNotFoundError` | `DOMAIN_NOT_FOUND` | 404 | Acting on a domain that isn't registered. |
| `DomainForbiddenError` | `DOMAIN_FORBIDDEN` | 403 | Acting on a domain that belongs to a different tenant. |

`TenantNotFoundError` declares no `status`, so adapters surface it as a generic
500 `INTERNAL_ERROR`; the others carry the code above.

- **`TENANT_REQUIRED` inside a queue job** — jobs don't inherit the request
  context. Wrap the body in `tenancy.run(tenantId, …)`, or pass an explicit
  fallback to `requireTenantId(id)`.
- **`ctx().tenant` is undefined even though the header is set** — the resolver
  produced a ref, but `source.find()` returned `null`; an unknown id falls
  through to the next resolver rather than failing.
- **A verified custom domain stopped resolving** — a `force` re-check found the
  TXT record missing and un-verified it. Re-publish the record and verify again.

### Hooks & events

| Hook | Payload | When |
|---|---|---|
| `tenancy:switched` | `{ tenant: Tenant }` | Whenever execution enters a tenant context — a resolved HTTP request, or `tenancy.run()` (including each iteration of `forEach()`). |

The plugin also declares `ctx().tenant?: Tenant` on `RequestContext`, so the
context is typed everywhere once this package is installed.

## Common errors and solutions (FAQ)

**"`ctx().tenant` is always `undefined`."** Check: (1) `tenancyPlugin` is registered **before** you read the context; (2) the request actually carries what the resolver expects (correct header, correct subdomain); (3) the tenant exists in the source — a resolver that identifies an unknown id is ignored.

**"404 TENANCY_NOT_RESOLVED on requests that should pass."** You have `required: true` and no resolver managed to load a tenant. For "central" routes (landing page, sign-up) use `required: false` and handle the absence of a tenant in the handler.

**"subdomainResolver doesn't catch `a.b.myapp.com`."** Intentional: it only accepts a single level of subdomain; `www` and the base domain are also ignored.

**"domainResolver always returns null."** Your `TenantSource` needs to implement `findByDomain`. In `MemoryTenantSource`, the tenant must have the `domains: ['app.acme.com']` field.

**"tenancy.forEach() throws TenantNotFoundError."** Your source doesn't implement the optional `list()` method — it's required for `forEach`.

**"Tenants disappear on restart."** `MemoryTenantSource` lives in memory; implement `TenantSource` on top of your database.

## How it connects to other modules

- **@basaltkit/core** — provides the per-request context (`ctx()`, AsyncLocalStorage) where the tenant is placed, and the hook bus (`tenancy:switched`).
- **@basaltkit/fastify** — runs the enricher that resolves the tenant on each HTTP request.
- **@basaltkit/auth** — independent, but complementary: auth says *who* the user is, tenancy says *where* (in which organization) the request is happening. API keys created within a tenant are scoped to it.
- **@basaltkit/permissions** — uses `ctx().tenant.id` as the default scope: permissions granted in one tenant don't apply in another.
- **@basaltkit/teams** — teams are the members of a tenant; team routes require `ctx().tenant` to be set by this module.

## Security best practices

- **Never trust a tenant header coming from the browser in production.** `headerResolver` is great for development and internal traffic, but a user can manually send `x-tenant-id: another-customer`. In production, prefer `subdomainResolver`/`domainResolver` (DNS is under your control) and always verify that the authenticated user **belongs** to the resolved tenant (the `teamRole` guard from `@basaltkit/teams` does this).
- **Isolate tenant data in your queries.** This module identifies the tenant; it's up to your code to use `ctx().tenant.id` in every database query. A query without a tenant filter is a data leak between customers.
- **Use `required: true` in application areas** so that a misrouted request fails loudly (404) instead of running with no tenant and touching global data.
- **Be careful with custom domains:** only accept a domain in `findByDomain` after the customer has proven they control it. `CustomDomains` + `findByVerifiedDomain` do exactly this — without them, someone can point a domain at your application and impersonate another tenant.
- **Scope with `tenantScoped()`, not by hand.** A hand-written `where` that
  forgets `tenantId`, or supplies `undefined`, reads every tenant's rows.

Guides: [Tenancy](/guide/tenancy) · [Creating a tenant](/guide/creating-a-tenant) · [Database per tenant](/guide/database-per-tenant) · [Teams](/guide/teams) · [Authorization](/guide/authorization).
