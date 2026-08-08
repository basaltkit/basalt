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
- [ ] **Tracing exported** — `tracingPlugin({ exporter })` (OTLP).
- [ ] **API documented** — `openapiPlugin({ info })`.
- [ ] **External delivery is reliable** — `outboxPlugin` / `webhooksPlugin`.
- [ ] **Real database** — put your domain data on `@machize/prisma`, and swap the
      framework's in-memory stores (auth, teams, subscriptions, permissions,
      comments, audit, activity, notifications) for their durable
      [`*-sqlite` / `*-prisma`](/guide/persistence) backends.
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

`@machize/prisma` is for **your** domain data. The framework's own stateful
domains — auth, teams, subscriptions, permissions, comments, audit, activity and
notifications — also default to in-memory and each has a durable backend to swap
in: `@machize/<domain>-sqlite` (single-node, `node:sqlite`, zero deps) or
`@machize/<domain>-prisma` (Postgres/MySQL). It's a one-line change per store
because the contract is unchanged. See the
[Persistence guide](/guide/persistence) for the catalog, and
[Database-per-tenant](/guide/database-per-tenant) to route those stores through
the active tenant's client.

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

## Reliability

- **Outbox** (`@machize/events`) — write events to a durable store, relay them to
  external systems with retries and a dead-letter ceiling. At-least-once
  delivery that survives crashes. See [Webhooks](/guide/webhooks).
- **Webhooks** (`@machize/webhooks`) — signed outbound delivery with backoff,
  per-tenant subscriptions, auto-dispatched from domain events.
- **Feature flags** (`@machize/flags`) — per-tenant/user targeting and
  deterministic rollouts for safe, gradual releases.

## Quality gates

`pnpm lint` (ESLint), `pnpm typecheck`, and `pnpm test:coverage` (V8, enforced
thresholds) all run in CI, alongside `pnpm audit`, CodeQL and a Postgres
integration job. Versions move in [lockstep](https://github.com/Zebedeu/machize/blob/main/VERSIONING.md)
across `@machize/*`, so one range covers the whole toolkit.

## Roadmap

Toward `1.0`: settling the API surface, first-class OpenTelemetry **metrics**
export (traces already export via OTLP), and more persistence adapters. Track
progress on the [repository](https://github.com/Zebedeu/machize).
