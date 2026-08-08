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

Don't hand-copy the models — run **`mach prisma:sync`**. It discovers every
installed `@machize/*-prisma` package and merges the models they need into your
`prisma/schema.prisma` (interactive by default; `--yes` adds them all,
`--only=auth,teams` restricts, `--push` applies immediately):

```bash
pnpm mach prisma:sync --push        # add missing models + create the tables
```

It's idempotent and never touches your own models. And if you wire a `*-prisma`
store before its models exist, the store now fails fast with a clear message
naming the missing model and pointing you here — no more cryptic
`reading 'create' of undefined`.

Otherwise, copy the reference models into your `schema.prisma`, `prisma migrate`, and go.
For **database-per-tenant** — every domain isolated in its own database or schema
with no per-store tenant filtering — pair it with `@machize/prisma` and route the
stores through the active tenant's client. That end-to-end setup has its own
guide: [Database-per-tenant](/guide/database-per-tenant).

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

## Subscriptions — `@machize/subscriptions-sqlite` / `@machize/subscriptions-prisma`

Billing has three stores — the **subscription** record, **usage** counters, and
**webhook** idempotency — and both durable backends implement all three:

```ts
import { subscriptionsPlugin } from '@machize/subscriptions'
import { sqliteSubscriptionsStores } from '@machize/subscriptions-sqlite'   // single-node
// import { prismaSubscriptionsStores } from '@machize/subscriptions-prisma' // Postgres/MySQL

const s = sqliteSubscriptionsStores('./data/billing.db')
subscriptionsPlugin({ plans, store: s.store, usage: s.usage, webhooks: s.webhooks })
```

The metered `consume()` is **atomic** in both: SQLite runs it in a
`BEGIN IMMEDIATE` transaction with a `RETURNING` guard; Prisma uses a conditional
`updateMany` that the database's row lock serializes. So a plan quota is never
overshot under concurrency — the same guarantee the Redis Lua store gives, now
without needing Redis. Webhook idempotency survives restarts and multiple
instances (a unique-id claim), so a redelivered event is processed once.

::: tip Already on Redis?
`@machize/subscriptions` still ships `RedisUsageStore` and `RedisWebhookStore` —
use those if Redis is already your shared store. The SQLite/Prisma backends add
the durable **subscription record** (which had no non-memory backend) and let you
persist all three in your primary database instead.
:::

## Comments, audit, activity & notifications

The content and observability stores follow the same two-backend pattern — one
store each, SQLite for a single node and Prisma for a shared database:

| Domain | Store | SQLite | Prisma |
| --- | --- | --- | --- |
| Comments | `CommentStore` | `sqliteCommentsStore()` | `prismaCommentsStore(prisma)` |
| Audit trail | `AuditStore` (append-only) | `sqliteAuditStore()` | `prismaAuditStore(prisma)` |
| Activity feed | `ActivityStore` | `sqliteActivityStore()` | `prismaActivityStore(prisma)` |
| In-app notifications | `InAppStore` | `sqliteInAppStore()` | `prismaInAppStore(prisma)` |
| Permissions | `AccessStore` | `sqliteAccessStore()` | `prismaAccessStore(prisma)` |

```ts
import { auditPlugin } from '@machize/audit'
import { sqliteAuditStore } from '@machize/audit-sqlite'          // single-node
// import { prismaAuditStore } from '@machize/audit-prisma'       // Postgres/MySQL

auditPlugin({ store: sqliteAuditStore('./data/audit.db').store })
```

Each returns `{ store }` (SQLite also exposes the shared `db`) named for its
plugin: `commentsPlugin({ store })`, `auditPlugin({ store })`,
`activityPlugin({ store })`, `notificationsPlugin({ inApp: store })`. Queries keep
the in-memory semantics — newest-first, tenant/recipient scoping, the audit
event-wildcard, unread filtering — now durable. JSON payloads (audit `payload`,
activity `properties`, notification `data`) are stored as text and round-trip
unchanged.

`@machize/permissions` follows the same shape: `permissionsPlugin({ store })`
takes the durable `AccessStore` (role assignments and grants, scoped), so RBAC
state survives a restart too. `@machize/flags` needs no backend — feature flags
are declared in code and evaluated deterministically, with nothing to persist.

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
