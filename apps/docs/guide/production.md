# Going to Production

A checklist for shipping a Basalt app, and where each capability lives. Most of
it is on by default — this page is about making the deliberate choices, and about
the handful of things that only bite in production. Each line links to the guide
that carries the full option table; nothing here restates one.

[[toc]]

## Checklist

- [ ] **Secrets are fail-closed** — sign with `secret()` so production refuses
      placeholders. See [Security](/guide/security#fail-closed-secrets-—-secret).
- [ ] **Edge is protected** — `securityPlugin({ rateLimit, cors, headers })`. The global
      limit is keyed by address only; a public API for machine clients gets
      `rateLimit.prefixes` and per-key budgets. See [Rate limiting](/guide/security#rate-limiting).
- [ ] **Logins are throttled** — on by default in `@basaltkit/auth`.
- [ ] **Mutations are idempotent** — `idempotencyPlugin()` for `POST` (binds keys to the request and replays after guards by default).
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
- [ ] **Built, not transpiled at runtime** — `pnpm build` + `node dist/src/server.js`
      (or the scaffold's `Dockerfile`); no tsx in production. See [Build & ship](#build-ship).
- [ ] **CI green** — build, typecheck, coverage gate, `pnpm audit`, CodeQL.
- [ ] **One deploy path** — on a single Linux server, `@basaltkit/deploy` runs
      the `.env`, infra, build, a pre-migration dump, the migration, the restart,
      a health check and a rollback. See [Deploying to a server](/guide/deploy).

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
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | A route declares a guarded security key (`meta.auth`, `can`, `teamRole`, `scopes`, `subscribed`, `feature`) and **no registered plugin enforces that key** — it would have served unprotected. Register the enforcing plugin (`authPlugin`, `permissionsPlugin`, `teamsPlugin`, `apiKeysPlugin`, `subscriptionsPlugin`), or, if the check genuinely happens at an outer edge, opt out explicitly with the adapter's `allowUnguardedMeta: true` (or a list of keys) |
| `CaptiveDependencyError` | `DI_CAPTIVE_DEPENDENCY` | A `scoped` token was resolved inside a **singleton** factory. The singleton outlives every scope, so it would serve request 1's per-request instance to every later request. Resolve the scoped service at use time (`ctx().container`) instead of at construction |

The unguarded-meta check is why declaring `meta.can` and forgetting
`permissionsPlugin` is a deploy failure and not a silent authorization hole. It
covers exactly the keys in `GUARDED_META_KEYS`; a `false`/`undefined` value on a
route is an explicit opt-off and is never flagged. See
[Authorization](/guide/authorization) and [Adapters](/guide/adapters).

With `prismaPlugin({ assertMigrated: true })` the boot also refuses a database
that is unreachable, not migrated, or that the app's role cannot use — and says
which, with the fix (a missing `GRANT`, a baseline, `migrate deploy`). The
meanings, a read-only `db:status` for CI and an idempotent post-deploy recipe
for grants and extensions are in [Database operations](/guide/database-operations).

## Persistence

Development runs on in-memory stores so there is nothing to install. In
production, `@basaltkit/prisma` offers three tenancy strategies — the domain code
(`db().model.findMany()`) is identical across all three:

| Strategy | Enable with |
| --- | --- |
| Shared database (row-level) | `prismaPlugin({ client: new PrismaClient({ adapter }).$extends(tenancyExtension()) })` |
| Database per tenant | `prismaPlugin({ forTenant: (id) => new PrismaClient({ adapter: new PrismaPg({ connectionString: urlFor(id) }) }) })` |
| Schema per tenant | `prismaPlugin({ schemaPerTenant: { url, createClient } })` |

A built-in `TenantClientPool` keeps connection counts bounded (never above
`max`, and it never evicts a client still in use — size `max` for the tenants
active at once, or new tenants get a 503 `TenantPoolExhaustedError`), and
`migrateTenants()` runs migrations across every tenant. Generate a
Prisma-backed resource with `basalt make:resource Invoice --prisma`.

**Fail fast on the wrong database.** `prismaPlugin({ client, assertMigrated: true })`
checks at boot that `_prisma_migrations` exists (`{ tables: [...] }` checks those
tables too) and refuses to start otherwise, naming the database and host it
reached — never the credentials (`PRISMA_NOT_MIGRATED`). It catches a shell that
exported another project's `DATABASE_URL` at startup instead of as a P2021 on
the first request. `{ forbiddenTables: [...] }` does the opposite check — tables
that must **not** be there, such as tenant tables recreated in the central
database — and refuses with `PRISMA_PLANE_MIXED`
([guard against the wrong plane](/guide/multi-tenant-pattern#guard-against-the-wrong-plane)).
Off by default.

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

When one database can't take the read load, add read replicas and split the
traffic: reads go to the replicas, writes stay on the primary. `readReplica` wraps
your Prisma clients and does the routing. It is a `Proxy`, not a dependency.

### What a replica is

A read replica is a **copy of the primary database**, kept current by replication:
PostgreSQL streaming replication, or your provider's "read replica" (RDS, Neon,
Supabase and others). It holds the same data and refuses writes.

::: danger A replica is never another database
Pointing a "replica" URL at a different database (another name on the same
server, a staging copy) does not fail at boot. It splits your data instead: a row
written to the primary is "not found" by the next read, which goes to the other
database.
:::

### 1. Declare the URLs in `src/env.ts`

One optional list, so the same code runs with no replica (development, a single
server) and with several:

```ts
// src/env.ts — inside defineEnv({ … })
DATABASE_URL: z.string().url(),
// Read replicas of DATABASE_URL, comma-separated. Empty: everything uses the primary.
DATABASE_REPLICA_URLS: z
  .string()
  .default('')
  .transform((value) => value.split(',').map((url) => url.trim()).filter(Boolean))
  .pipe(z.array(z.string().url())),
```

```sh
# .env
DATABASE_URL=postgres://…@db-primary:5432/app
DATABASE_REPLICA_URLS=postgres://…@db-replica-1:5432/app,postgres://…@db-replica-2:5432/app
```

### 2. Wire the client

```ts
// src/app.ts
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { prismaPlugin, readReplica } from '@basaltkit/prisma'
import { env } from './env.js'

// Prisma 7 connects through a driver adapter: one client per connection string.
const pg = (connectionString: string) => new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

export const client = readReplica({
  primary: pg(env.DATABASE_URL),
  replicas: env.DATABASE_REPLICA_URLS.map(pg),
  // Multi-tenant? Apply the SAME extension to the primary and every replica:
  // extend: (c) => c.$extends(tenancyExtension()),
})

// in createApp({ plugins: [ … ] }):
prismaPlugin({ client })
```

With no replica URL, `readReplica` returns the primary unchanged, plus `$primary`.

### 3. Use it inside a request

`db()` returns the client of the **current request**. Call it inside the handler,
never at the top of a module: at import time there is no request, and the app
fails to start with `DbUnavailableError`.

```ts
import { db } from '@basaltkit/prisma'
import type { client } from '../app.js'

route({
  method: 'POST',
  url: '/orders',
  handler: async ({ body }) => {
    const prisma = db<typeof client>()                       // here, not at module level
    const order = await prisma.order.create({ data: body })  // write → primary
    // Right after a write a replica may still lag: read it back from the primary.
    return prisma.$primary.order.findUnique({ where: { id: order.id } })
  },
})
```

### What goes where

| Call | Goes to |
|---|---|
| `findMany`, `findFirst`, `findFirstOrThrow`, `findUnique`, `findUniqueOrThrow`, `count`, `aggregate`, `groupBy` | a replica, round-robin |
| `create`, `update`, `upsert`, `delete`, and the other writes | the primary |
| `$transaction`, `$executeRaw`, `$executeRawUnsafe` | the primary |
| `$queryRaw`, `$queryRawUnsafe` | the primary, unless you pass `rawReadsOnReplica: true` |
| anything through `$primary` | the primary |

Raw queries stay on the primary by default for two reasons: raw SQL can write (a
`WITH … INSERT`), and a read that decides access (a permission or a session check)
must not read lagged data. Opt in with `rawReadsOnReplica: true` only when every
raw query in the app is read-only and lag-tolerant. If an extension adds model
methods that only read, list them with `readOps: ['…']`.

**Multi-tenant:** a raw, un-extended replica would route reads around your tenant
filter and leak other tenants' rows. Pass `extend`, as above, so the primary and
every replica carry the same `tenancyExtension()`.

### Try it locally

This compose file runs a PostgreSQL primary and one streaming replica, cloned with
`pg_basebackup`. It is for development only: the passwords are fixed and there is
no TLS.

::: details `docker/compose.replica.yml` and its two scripts
```yaml
# docker/compose.replica.yml
name: app-replica
services:
  primary:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres, POSTGRES_DB: app }
    command: [postgres, -c, wal_level=replica, -c, max_wal_senders=5, -c, hot_standby=on]
    ports: ["127.0.0.1:55460:5432"]
    volumes:
      - primary-data:/var/lib/postgresql/data
      - ./replica/init-primary.sh:/docker-entrypoint-initdb.d/10-replication.sh:ro
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres -d app"], interval: 2s, retries: 30 }
  replica:
    image: postgres:16-alpine
    depends_on: { primary: { condition: service_healthy } }
    environment:
      PGDATA: /var/lib/postgresql/data
      PRIMARY_HOST: primary
      REPLICATION_USER: replicator
      REPLICATION_PASSWORD: replicator
    entrypoint: ["/bin/sh", "/replica/start-replica.sh"]
    ports: ["127.0.0.1:55461:5432"]
    volumes:
      - replica-data:/var/lib/postgresql/data
      - ./replica/start-replica.sh:/replica/start-replica.sh:ro
volumes: { primary-data: {}, replica-data: {} }
```

```sh
#!/bin/sh
# docker/replica/init-primary.sh — runs once, when the primary is created
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';"
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
```

```sh
#!/bin/sh
# docker/replica/start-replica.sh — clones the primary on first start, then runs read-only
set -eu
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
  su-exec postgres env PGPASSWORD="$REPLICATION_PASSWORD" \
    pg_basebackup -h "$PRIMARY_HOST" -U "$REPLICATION_USER" -D "$PGDATA" -R -X stream -P
fi
exec su-exec postgres postgres -c hot_standby=on
```
:::

```sh
chmod +x docker/replica/*.sh   # without it the primary exits: "bad interpreter: Permission denied"
docker compose -f docker/compose.replica.yml up -d
# .env
DATABASE_URL=postgres://postgres:postgres@localhost:55460/app
DATABASE_REPLICA_URLS=postgres://postgres:postgres@localhost:55461/app
```

Create your tables **on the primary** only (`prisma migrate deploy` with
`DATABASE_URL`). The replica receives them through replication. Check that
replication runs:

```sh
docker compose -f docker/compose.replica.yml exec primary \
  psql -U postgres -d app -c "SELECT client_addr, state FROM pg_stat_replication"   # state: streaming
docker compose -f docker/compose.replica.yml exec replica \
  psql -U postgres -d app -c "SELECT pg_is_in_recovery()"                           # t: read-only
```

`docker compose -f docker/compose.replica.yml down -v` stops both and deletes the
data.

### Check the routing

Pause replay on the replica for a moment, and a write the app just made is
visible through `$primary` but not to a plain read. That proves reads go to the
replica:

```ts
// scripts/replica-check.ts — run with `pnpm tsx scripts/replica-check.ts`
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { client } from '../src/app.js'

const replica = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_REPLICA_URLS!.split(',')[0]! }) })
const id = `replica-check-${Date.now()}`
try {
  await replica.$queryRawUnsafe('SELECT pg_wal_replay_pause()::text')
  await client.order.create({ data: { id /* … */ } })                            // primary
  console.log('plain read:', await client.order.findUnique({ where: { id } }))  // null: the replica is paused
  console.log('$primary:', await client.$primary.order.findUnique({ where: { id } }))  // the row
} finally {
  await replica.$queryRawUnsafe('SELECT pg_wal_replay_resume()::text')
  await client.$primary.order.deleteMany({ where: { id } })
  await replica.$disconnect()
  await client.$primary.$disconnect()
}
```

A write sent straight to the replica fails with
`cannot execute INSERT in a read-only transaction`.

TLS, connection limits and failover belong to your database provider. Basalt only
routes the calls.

## Sharding the database

Read replicas scale reads; **sharding scales writes and storage** by spreading
tenants across several databases. `ShardRouter` maps a tenant id to a shard with
a stable hash — a tenant's data always lands on the same database:

```ts
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { prismaPlugin, ShardRouter } from '@basaltkit/prisma'

const shards = new ShardRouter({
  shards: [
    new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SHARD_0_URL }) }),
    new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SHARD_1_URL }) }),
    new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.SHARD_2_URL }) }),
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

`prisma migrate dev` only migrates `DATABASE_URL`, never the shards: check them
with [`db:status`](./database-operations#shards) and run `prisma migrate deploy`
per shard.

Sharding is for **scale-out**, not isolation — for one-database-per-tenant use
`prismaPlugin({ forTenant })` instead. Changing `shards.length` re-maps keys, so
plan a migration before you resize; pass a custom `hash` if you need consistent
hashing to minimise reshuffling.

## Build & ship

A create-basalt app runs on **plain node** in production — tsx is a
devDependency and never ships. Three scripts carry it:

```bash
pnpm build       # tsc -p tsconfig.build.json → dist/ (src/ only; rootDir ".")
pnpm start       # node --env-file-if-exists=.env --enable-source-maps dist/src/server.js
pnpm start:dev   # tsx src/server.ts — the server from source, no build
```

`tsconfig.build.json` extends `tsconfig.json` (so `pnpm typecheck` and the build
never disagree), compiles `src/` only — tests and `bin/` (the generators, the
dev-only AI bridge) stay out — and keeps `rootDir: "."`, so `src/server.ts`
lands at `dist/src/server.js`.

The scaffold also ships a `Dockerfile` — the same file
`basalt publish dockerfile` writes, from one source in `@basaltkit/cli`:

| Stage | What it does |
| --- | --- |
| `build` | `pnpm install --frozen-lockfile` (devDependencies included), `prisma generate` when `prisma/schema.prisma` exists, `pnpm run build`, then `pnpm prune --prod --ignore-scripts` — tsx, TypeScript, the Prisma CLI, the generators and `@basaltkit/ai-mcp` never reach the image |
| `run` | `node:22-slim`, `NODE_ENV=production`, copies `node_modules`, `dist/` and `generated/`, runs as `USER node`, `HEALTHCHECK` on `$HEALTHCHECK_PATH` (default `/health`, the scaffold's route — set `/readyz` with `healthPlugin`), `CMD ["node", "--enable-source-maps", "dist/src/server.js"]` |

```bash
docker build -t my-saas .
docker run -p 3000:3000 -e MY_SAAS_APP_SECRET=… -e MY_SAAS_DATABASE_URL=… my-saas
```

Configuration comes from the environment: the image loads no `.env`, and
`.dockerignore` keeps it (and keys, `node_modules`, a local `dist/`) out of the
build context. **Migrations are not run by the image** — apply them before you
roll out (`pnpm db:deploy` in CI or a release job); the app refuses to boot on
an unmigrated database (`assertMigrated`). A Prisma app needs its client outside
`src/` and `@prisma/client-runtime-utils` as a direct dependency — see
[Prisma with pnpm](/guide/persistence#prisma-with-pnpm-the-generated-client).

An app scaffolded before this existed: `pnpm basalt update` offers
`tsconfig.build.json`, the `build` script and the Dockerfile, and prints the
`start` change instead of making it; `pnpm basalt doctor` reports what is
missing. The create-basalt suite builds fresh scaffolds and boots
`node dist/src/server.js` until `/health` answers.

::: tip Deploying to your own server
For a single Linux server (PM2 or Docker Compose behind Apache or Caddy),
`@basaltkit/deploy` runs the whole release, migrations included, and
`@basaltkit/deploy-ui` drives it from your machine. See
[Deploying to a server](/guide/deploy).
:::

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
  At-least-once delivery that survives crashes — provided the store is durable,
  the entry is written in the business transaction (`enqueue(…, { tx })`), and
  `onDead` / `onFlushError` reach a human. With several replicas, use a claiming
  store (`prismaOutboxStore(prisma, { claim: true })`) so relays don't double-dispatch. Options in
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
