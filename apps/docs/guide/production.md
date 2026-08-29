# Going to Production

A checklist for shipping a Basalt app, and where each capability lives. Most of
it is on by default — this page is about making the deliberate choices, and about
the handful of things that only bite in production. Each line links to the guide
that carries the full option table; nothing here restates one.

[[toc]]

## Checklist

- [ ] **Secrets are fail-closed** — sign with `secret()` so production refuses
      placeholders. See [Security](/guide/security#fail-closed-secrets-secret).
- [ ] **Edge is protected** — `securityPlugin({ rateLimit, cors, headers })`.
- [ ] **Logins are throttled** — on by default in `@basaltkit/auth`.
- [ ] **Mutations are idempotent** — `idempotencyPlugin()` for `POST`.
- [ ] **The app boots on a cold start with production config** — the boot-time
      guards below only fire when you actually call `boot()`.
- [ ] **Health probes wired** — `healthPlugin({ checks })` for `/livez` + `/readyz`.
- [ ] **Metrics scraped** — `metricsPlugin()` at `/metrics`, and neither it nor
      `/readyz` is reachable from the internet.
- [ ] **Tracing exported** — `tracingPlugin({ exporter })` (OTLP), with
      `serviceName` set on the **exporter** too.
- [ ] **Nothing important logs to `console.error`** — point the async error
      callbacks at your logger: realtime `onBridgeError` / `onDeliveryError`, the
      outbox's `onDead` / `onFlushError`, the queue drivers' `onError` /
      `onJobFailed`. All default to the console, which most platforms discard.
      See [Observability](/guide/observability).
- [ ] **API documented** — `openapiPlugin({ info })`.
- [ ] **External delivery is reliable** — `outboxPlugin` / `webhooksPlugin`.
- [ ] **Scheduled work runs once, not once per replica** — `.onOneServer()` with a
      shared `ScheduleLock`. See [Scheduler](/guide/scheduler).
- [ ] **Real database** — put your domain data on `@basaltkit/prisma`, and swap the
      framework's in-memory stores (auth, teams, subscriptions, permissions,
      comments, audit, activity, notifications) for their durable
      [`*-sqlite` / `*-prisma`](/guide/persistence) backends.
- [ ] **Migrations run per tenant** — `migrateTenants()` / `basalt` command.
- [ ] **CI green** — build, typecheck, coverage gate, `pnpm audit`, CodeQL.

## A production-shaped `buildApp`

```ts
import { createApp } from '@basaltkit/core'
import {
  fastifyPlugin, securityPlugin, healthPlugin, metricsPlugin,
  openapiPlugin, idempotencyPlugin,
} from '@basaltkit/fastify'
import { prismaPlugin } from '@basaltkit/prisma'
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

## What fails loud at boot

Two classes of misconfiguration are caught by `boot()` rather than discovered in
production. Both throw, so a bad deploy dies on the launch instead of serving
traffic — which is only useful if your pipeline actually boots the app (a smoke
test, or the first container failing its readiness probe).

| Error | Code | Means |
| --- | --- | --- |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | A route declares `meta.auth`, `meta.can` or `meta.teamRole` and **no registered plugin enforces that key** — it would have served unprotected. Register the enforcing plugin (`authPlugin`, `permissionsPlugin`, `teamsPlugin`), or, if the check genuinely happens at an outer edge, opt out explicitly with the adapter's `allowUnguardedMeta: true` (or a list of keys) |
| `CaptiveDependencyError` | `DI_CAPTIVE_DEPENDENCY` | A `scoped` token was resolved inside a **singleton** factory. The singleton outlives every scope, so it would serve request 1's per-request instance to every later request. Resolve the scoped service at use time (`ctx().container`) instead of at construction |

The unguarded-meta check is why declaring `meta.can` and forgetting
`permissionsPlugin` is a deploy failure and not a silent authorization hole. It
covers exactly the keys in `GUARDED_META_KEYS`; a `false`/`undefined` value on a
route is an explicit opt-off and is never flagged. See
[Authorization](/guide/authorization) and [Adapters](/guide/adapters).

## Persistence

Development runs on in-memory stores so there is nothing to install. In
production, `@basaltkit/prisma` offers three tenancy strategies — the domain code
(`db().model.findMany()`) is identical across all three:

| Strategy | Enable with |
| --- | --- |
| Shared database (row-level) | `prismaPlugin({ client: new PrismaClient().$extends(tenancyExtension()) })` |
| Database per tenant | `prismaPlugin({ forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }) })` |
| Schema per tenant | `prismaPlugin({ schemaPerTenant: { url, createClient } })` |

A built-in LRU `TenantClientPool` keeps connection counts bounded, and
`migrateTenants()` runs migrations across every tenant. Generate a
Prisma-backed resource with `basalt make:resource Invoice --prisma`.

`@basaltkit/prisma` is for **your** domain data. The framework's own stateful
domains — auth, teams, subscriptions, permissions, comments, audit, activity and
notifications — also default to in-memory and each has a durable backend to swap
in: `@basaltkit/<domain>-sqlite` (single-node, `node:sqlite`, zero deps) or
`@basaltkit/<domain>-prisma` (Postgres/MySQL). It's a one-line change per store
because the contract is unchanged. See the
[Persistence guide](/guide/persistence) for the catalog, and
[Database-per-tenant](/guide/database-per-tenant) to route those stores through
the active tenant's client.

## Scaling reads (read replicas)

When one database can't take the read load, add read replicas and split traffic:
reads go to the replicas, writes stay on the primary. `readReplica` wraps any
Prisma client and does the routing — it's a `Proxy`, not a dependency:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, readReplica } from '@basaltkit/prisma'

const client = readReplica({
  // apply the SAME extension to primary AND replicas — never leave a replica un-scoped
  // extend: (c) => c.$extends(tenancyExtension()),
  primary: new PrismaClient({ datasourceUrl: process.env.DATABASE_URL }),
  replicas: [
    new PrismaClient({ datasourceUrl: process.env.REPLICA_1_URL }),
    new PrismaClient({ datasourceUrl: process.env.REPLICA_2_URL }),
  ],
})

app.use(prismaPlugin({ client }))
```

Multi-tenant? Pass `extend: (c) => c.$extends(tenancyExtension())` so **every** replica carries your tenant filter — a raw replica would route reads around it and leak rows. `$queryRaw`/`$queryRawUnsafe` stay on the **primary** by default (raw SQL can mutate and gating reads must not be stale); opt in with `rawReadsOnReplica: true` for genuinely read-only raw queries.

`findMany`, `findUnique`, `count`, `aggregate`, `groupBy` and `$queryRaw`
round-robin across the replicas; every write, `$transaction` and `$executeRaw`
goes to the primary. Right after a write, replicas may lag — force the primary
for a read-your-writes check with the `$primary` escape hatch:

```ts
await db().order.create({ data })
const fresh = await db<Client>().$primary.order.findMany({ where: { userId } })
```

With `replicas: []` it returns the primary unchanged, so the same wiring runs in
dev and in a single-node deploy. Applying `tenancyExtension()`? Extend the
primary **and** each replica, then wrap the extended clients. (TLS/connection
details are your database provider's; Basalt only routes the calls.)

## Sharding the database

Read replicas scale reads; **sharding scales writes and storage** by spreading
tenants across several databases. `ShardRouter` maps a tenant id to a shard with
a stable hash — a tenant's data always lands on the same database:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, ShardRouter } from '@basaltkit/prisma'

const shards = new ShardRouter({
  shards: [
    new PrismaClient({ datasourceUrl: process.env.SHARD_0_URL }),
    new PrismaClient({ datasourceUrl: process.env.SHARD_1_URL }),
    new PrismaClient({ datasourceUrl: process.env.SHARD_2_URL }),
  ],
})

app.use(prismaPlugin({ shards }))
// each request's tenant is routed to its shard; db() reads the right one
```

Shard clients are **long-lived and shared** by all the tenants that hash to them
(unlike the per-tenant pool, nothing is evicted). For cross-shard work — a
migration, a platform-wide report — fan out over `shards.all()`:

```ts
await Promise.all(shards.all().map((db) => db.$executeRawUnsafe(migrationSql)))
```

Sharding is for **scale-out**, not isolation — for one-database-per-tenant use
`prismaPlugin({ forTenant })` instead. Changing `shards.length` re-maps keys, so
plan a migration before you resize; pass a custom `hash` if you need consistent
hashing to minimise reshuffling.

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

- **Outbox** (`@basaltkit/events`) — write events to a durable store, relay them to
  external systems with retries, exponential backoff and a dead-letter ceiling.
  At-least-once delivery that survives crashes — provided the store is durable
  and `onDead` / `onFlushError` reach a human. Options in
  [Persistence](/guide/persistence); the delivery side in
  [Webhooks](/guide/webhooks).
- **Webhooks** (`@basaltkit/webhooks`) — signed outbound delivery with backoff,
  per-tenant subscriptions, auto-dispatched from domain events.
- **Queues** (`@basaltkit/queue`) — background work with driver-level `onError` /
  `onJobFailed` reporting; see [Queues](/guide/queues).
- **Realtime** (`@basaltkit/realtime`) — pushes are fire-and-forget by design and
  can never fail a domain write, which also means their failures are only visible
  through `onBridgeError` / `onDeliveryError`. See [Realtime](/guide/realtime).
- **Feature flags** (`@basaltkit/flags`) — per-tenant/user targeting and
  deterministic rollouts for safe, gradual releases.

## Quality gates

`pnpm lint` (ESLint), `pnpm typecheck`, and `pnpm test:coverage` (V8, enforced
thresholds) all run in CI, alongside `pnpm audit`, CodeQL and a Postgres
integration job. Each `@basaltkit/*` package is versioned **independently** —
depend on each with its own `^` range; the "Basalt X.Y" number in the nav is a
label for a generation of the framework, not a package version. See
[Versioning & compatibility](/guide/versioning).

## Roadmap

Past `1.0` the public API is stable and breaking changes wait for a major. Next
up: first-class OpenTelemetry **metrics** export (traces already export via
OTLP), and more persistence adapters. Track progress on the
[repository](https://github.com/basaltkit/basalt), and see
[What's new](/guide/whats-new) for the current generation.
