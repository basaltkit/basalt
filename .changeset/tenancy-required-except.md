---
'@basaltkit/tenancy': minor
---

**`required` can now exempt paths, so it is usable by apps that have public routes.**

`required: true` rejects any request that resolved no tenant. It applied to
every route, which most apps cannot live with: a health check has no tenant to
send — a load balancer will never set the header — and neither does a landing
page or a public pricing endpoint. The only way out was `required: false`, which
drops the guard everywhere and leaves each handler to notice the absent tenant
on its own.

```ts
tenancyPlugin({
  source: tenants,
  resolvers: [headerResolver()],
  required: { except: ['/', '/health', '/openapi.json', /^\/public\//] },
})
```

Entries are exact strings or regular expressions, matched against the path
without its query string, so `/health` also covers `/health?probe=1`. A URL that
cannot be matched is treated as required — the guard fails closed.

Exempting a path lifts only the tenant requirement. Auth, subscription checks
and every other guard still run.

`required: true` and `required: false` behave exactly as before.

### One detail that had to be right on all three adapters

Adapters report the URL differently: Fastify and Express pass a path with its
query (`/health?probe=1`), Hono passes an absolute URL
(`http://host/health`). Comparing the raw string would have matched on two
adapters and silently never on the third, turning an exemption into a 404 only
on Hono. The path is normalised before matching, and all three shapes are
covered by tests.

Also exports `isTenantRequired(required, url)`.
