---
'@basaltkit/tenancy': minor
'@basaltkit/http': minor
---

**A route can now declare whether it needs a tenant, with `meta.tenant`.**

Separating central routes from tenant routes meant listing paths in
`required: { except }` — which puts the decision in a different file from the
route it describes. Rename the URL and the exemption silently stops matching,
with no error anywhere: the route just starts 404ing for callers who never sent
a tenant.

```ts
// Central: no tenant, ever.
route({ method: 'GET', url: '/pricing', meta: { tenant: false }, handler })

// Tenant: refuse the request if none resolved.
route({ method: 'GET', url: '/invoices', meta: { tenant: true }, handler })
```

`meta.tenant` overrides the app-wide `required` in both directions, which makes
the useful combination possible: `required: true` to deny by default, and the
handful of central routes — health check, landing page, sign-up, tenant
creation — opting out next to their own handler, where a reviewer sees it.

A central route still *resolves* a tenant when one is present, so `ctx().tenant`
is populated on `acme.example.com/pricing`. Only the requirement is lifted. A
non-boolean `meta.tenant` is ignored rather than guessed at, since `meta` is
free-form and shared with every other plugin.

`required: true`, `required: false` and `required: { except }` are unchanged, and
remain the right tool for paths you do not own — routes mounted by another
package.

### `@basaltkit/http`

`RequestEnricher` now receives the `route` being served, so an enricher can read
its `meta`. Guards already got this; enrichers did not, which is why tenancy
could only look at the URL. The field is optional and additive — existing
enrichers are unaffected — and it is passed from the shared pipeline, so it
works identically on Fastify, Express and Hono.
