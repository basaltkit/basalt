# Persistence & durable stores

Most Machize building blocks keep their state behind a small **store contract**
(an interface), and ship an **in-memory implementation** as the default. That's
deliberate: you can build and test a whole app with no database running. But an
in-memory store loses everything when the process exits — fine for dev and CI,
not for production.

Going to production means swapping the in-memory stores for durable ones. The
contract stays identical, so it's a one-line change per store — no rewrite.

[[toc]]

## The pattern

Take authentication. `authPlugin` accepts a `UserSource`, a `SessionStore`, a
`RefreshTokenStore`, and more. Give it nothing and it uses the in-memory
defaults; give it durable implementations and your users stay logged in across a
redeploy:

```ts
authPlugin({ secret })                       // dev — in-memory, forgets on restart
authPlugin({ secret, users, sessions, ... }) // prod — durable stores
```

Every store is just an interface. You can implement one against any database you
already run, or reach for a ready-made package.

## Auth on SQLite — `@machize/auth-sqlite`

The reference "real backend" for auth is [`@machize/auth-sqlite`](/reference/packages):
durable implementations of **all six** auth stores — users, sessions, refresh
tokens, one-time (verify/reset) tokens, API keys and MFA — on Node's built-in
`node:sqlite`. No ORM, no migration tool, no separate service, zero external
dependencies.

```ts
import { authPlugin, apiKeysPlugin } from '@machize/auth'
import { sqliteAuthStores } from '@machize/auth-sqlite'

const s = sqliteAuthStores('./data/auth.db')   // ':memory:' by default

createApp({
  plugins: [
    authPlugin({
      secret: process.env.AUTH_SECRET!,
      users: s.users,
      sessions: s.sessions,
      refreshTokens: s.refreshTokens,
      tokens: s.tokens,   // email verification + password reset
      mfa: s.mfa,
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
})
```

`sqliteAuthStores()` opens (or creates) the file, applies an idempotent schema,
and hands back every store named to slot straight into the plugins. The rest of
your auth code is untouched — these classes implement the same contracts as the
in-memory stores. Each store is also exported on its own (`SqliteUserSource`, …)
so you can mix backends.

::: tip Node version
`node:sqlite` is stable and flag-free on **Node 24**; on Node 22.x run with
`--experimental-sqlite`. Requires Node 22.5+.
:::

SQLite is a genuinely production-grade default for single-node apps. Run
multiple instances that must share session state? Point sessions/refresh tokens
at Redis and keep users in your primary database — the contracts make that a
per-store choice.

## Auth on Postgres/MySQL — `@machize/auth-prisma`

When your app already runs on a real database, [`@machize/auth-prisma`](/reference/packages)
gives you the same six auth stores backed by **Prisma**. You bring a generated
`PrismaClient` whose schema includes the `Auth*` models (the package ships a
reference `schema.prisma`); the stores only touch those delegates, so they layer
onto your existing client without owning your schema or connection.

```ts
import { authPlugin, apiKeysPlugin } from '@machize/auth'
import { prismaAuthStores } from '@machize/auth-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const s = prismaAuthStores(prisma)   // pass your client directly, no cast

createApp({
  plugins: [
    authPlugin({ secret, users: s.users, sessions: s.sessions,
                 refreshTokens: s.refreshTokens, tokens: s.tokens, mfa: s.mfa }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
})
```

Copy the reference models into your `schema.prisma`, `prisma migrate`, and go.
For **database-per-tenant**, pair it with [`@machize/prisma`](/reference/packages):
resolve the per-tenant client from the request context and build the stores over
it, so each tenant's auth data lives in its own database or schema.

::: tip Which one?
`@machize/auth-sqlite` for a single node with zero dependencies;
`@machize/auth-prisma` when you already run Postgres/MySQL or need multiple
instances to share one database. Both implement the identical store contracts,
so switching is a one-line change.
:::

## Teams — `@machize/teams-sqlite` / `@machize/teams-prisma`

`@machize/teams` keeps memberships and invitations behind the same kind of store
contract, and ships the same two durable backends — so team rosters and pending
invitations survive a restart too:

```ts
import { teamsPlugin } from '@machize/teams'
import { sqliteTeamsStores } from '@machize/teams-sqlite'   // single-node, zero-dep
// import { prismaTeamsStores } from '@machize/teams-prisma' // Postgres/MySQL

const t = sqliteTeamsStores('./data/teams.db')
teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
```

`prismaTeamsStores(prisma)` is the drop-in Prisma equivalent (bring a client with
the `Team*` models from the bundled reference schema). Same "which one?" trade-off
as auth: SQLite for a single node, Prisma when you already run a database or need
to share it across instances. They can share one handle with the auth stores.

## Redis-backed stores

Several packages already ship Redis implementations for the state that benefits
most from being shared across instances:

| Concern | In-memory (default) | Durable / shared |
| --- | --- | --- |
| Cache | `MemoryCacheDriver` | `RedisCacheDriver` (`@machize/cache`), tiered (`@machize/cache-tiered`) |
| Usage metering | `MemoryUsageStore` | `RedisUsageStore` — atomic `consume()` via Lua |
| Webhook idempotency | `MemoryWebhookStore` | `RedisWebhookStore` — `SET NX EX` across restarts |
| Queues | in-memory driver | RabbitMQ / Kafka / SQS driver packages |
| Search | `MemorySearchDriver` | Meilisearch / Postgres driver packages |
| Storage | local disk | S3 / GCS / Azure driver packages |

## Writing your own store

A store is a handful of async methods. To back auth users with your existing
database, implement `UserSource`:

```ts
import type { UserSource, AuthUser, UserPatch } from '@machize/auth'

class PrismaUserSource implements UserSource {
  async findByEmail(email: string): Promise<AuthUser | null> { /* … */ }
  async findById(id: string): Promise<AuthUser | null> { /* … */ }
  async create(data: { email: string; passwordHash: string }): Promise<AuthUser> { /* … */ }
  async update(id: string, patch: UserPatch): Promise<AuthUser | null> { /* … */ }
}
```

`@machize/auth-sqlite` and `@machize/auth-prisma` are compact, fully-tested
references for all six auth stores — read either when you build one for another
database or ORM. The same approach applies to every other store contract in the
toolkit.

## What to do before going to production

- Replace in-memory **auth** stores with `@machize/auth-sqlite` (or your own DB).
- Move **cache**, **usage metering** and **webhook idempotency** to Redis if you
  run more than one instance.
- Point **queues**, **search** and **storage** at their production drivers.

See [Going to Production](/guide/production) for the full checklist.
