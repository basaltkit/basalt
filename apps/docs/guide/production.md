# Going to Production

A checklist for shipping a Machize app, and where each capability lives. Most of
it is on by default — this page is about making the deliberate choices.

## Checklist

- [ ] **Secrets are fail-closed** — sign with `secret()` so production refuses
      placeholders. See [Security](/guide/security#fail-closed-secrets-secret).
- [ ] **Edge is protected** — `securityPlugin({ rateLimit, cors, headers })`.
- [ ] **Logins are throttled** — on by default in `@machize/auth`.
- [ ] **Mutations are idempotent** — `idempotencyPlugin()` for `POST`.
- [ ] **Health probes wired** — `healthPlugin({ checks })` for `/livez` + `/readyz`.
- [ ] **Metrics scraped** — `metricsPlugin()` at `/metrics`.
- [ ] **API documented** — `openapiPlugin({ info })`.
- [ ] **Real database** — swap in-memory stores for `@machize/prisma`.
- [ ] **Migrations run per tenant** — `migrateTenants()` / `mach` command.
- [ ] **CI green** — build, typecheck, coverage gate, `pnpm audit`, CodeQL.

## A production-shaped `buildApp`

```ts
import { createApp } from '@machize/core'
import {
  fastifyPlugin, securityPlugin, healthPlugin, metricsPlugin,
  openapiPlugin, idempotencyPlugin,
} from '@machize/fastify'
import { prismaPlugin } from '@machize/prisma'
import { env } from './env.js'

export function buildApp() {
  return createApp({
    plugins: [
      // ...tenancy, auth, subscriptions, your domain plugins...
      prismaPlugin({ forTenant: (id) => clientFor(id) }), // database per tenant
      securityPlugin({
        rateLimit: { limit: 300, windowMs: 60_000 },
        cors: { origin: env.WEB_ORIGIN.split(','), credentials: true },
        headers: true,
      }),
      idempotencyPlugin(),
      healthPlugin({ checks: { db: () => ({ ok: pool.isHealthy() }) } }),
      metricsPlugin(),
      openapiPlugin({ info: { title: 'My API', version: '1.0.0' } }),
      fastifyPlugin({ routes, fastify: { bodyLimit: 1_048_576, trustProxy: true } }),
    ],
  })
}
```

::: tip Request limits
Pass Fastify server options through `fastifyPlugin({ fastify })`: `bodyLimit`
(max request size), `requestTimeout`, and `trustProxy` (so rate limiting and
logging see the real client IP behind a load balancer).
:::

## Persistence

Development runs on in-memory stores so there is nothing to install. In
production, `@machize/prisma` offers three tenancy strategies — the domain code
(`db().model.findMany()`) is identical across all three:

| Strategy | Enable with |
| --- | --- |
| Shared database (row-level) | `prismaPlugin({ client: new PrismaClient().$extends(tenancyExtension()) })` |
| Database per tenant | `prismaPlugin({ forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }) })` |
| Schema per tenant | `prismaPlugin({ schemaPerTenant: { url, createClient } })` |

A built-in LRU `TenantClientPool` keeps connection counts bounded, and
`migrateTenants()` runs migrations across every tenant. Generate a
Prisma-backed resource with `mach make:resource Invoice --prisma`.

## Graceful shutdown

`app.shutdown()` runs every plugin's `shutdown` in reverse boot order (closing
the server, draining pools). Wire it to signals:

```ts
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.shutdown()
    process.exit(0)
  })
}
```

## CI/CD

The repo ships GitHub Actions that gate every PR:

- **CI** — build, typecheck and test on Node 22 & 24; a **coverage** job that
  enforces thresholds (`pnpm test:coverage`); a Postgres **integration** job.
- **audit** — `pnpm audit --audit-level=high`.
- **CodeQL** — static analysis, weekly + on PRs.
- **Release** — changesets open a version PR and publish to npm with
  **provenance** on merge.

## Roadmap

Shipping next, tracked on the [milestones](https://github.com/Zebedeu/machize):
outbound **webhooks** with signed delivery, an **events outbox** for
at-least-once delivery to external systems, **feature flags** with per-tenant
targeting, first-class **OpenTelemetry** tracing export, and the 1.0
versioning policy (lockstep internal versions to end the `^0.x` minor footgun).
