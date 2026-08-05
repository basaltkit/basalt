# Multi-tenancy

`@machize/tenancy` makes every request tenant-aware. Once the tenant is
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
} from '@machize/tenancy'

tenancyPlugin({
  source: new MemoryTenantSource()
    .add({ id: 'acme', name: 'Acme Inc' })
    .add({ id: 'globex', name: 'Globex' }),
  resolvers: [
    headerResolver(),                          // x-tenant-id: acme
    subdomainResolver({ base: 'machize.app' }), // acme.machize.app
  ],
})
```

Other resolvers: `domainResolver()` (custom domains via `source.findByDomain`)
and `routeResolver({ param: 'tenant' })` (`/t/:tenant/...`). Any async
`(request) => tenantId | null` works as a custom resolver.

`MemoryTenantSource` is for development and tests — in production you implement
the `TenantSource` contract over your database.

## Reading the tenant

```ts
import { ctx } from '@machize/core'

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
import { TENANCY } from '@machize/tenancy'

const tenancy = app.container.get(TENANCY)

await tenancy.run('acme', async () => {
  // ctx().tenant is now Acme; everything scopes to it
})

await tenancy.forEach(async (tenant) => {
  // bulk maintenance across every tenant
}, { concurrency: 5 })
```

## Isolation modes

The default is **shared database** — a `tenantId` column filtered
automatically by the [`@machize/prisma`](/reference/packages) extension. Migrating
to schema-per-tenant or database-per-tenant is configuration, not a rewrite: your
queries stay `ctx().db.user.findMany()` in all three modes.
