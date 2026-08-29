# Persistence & durable stores

Most Basalt building blocks keep their state behind a small **store contract**
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

## Auth on SQLite — `@basaltkit/auth-sqlite`

The reference "real backend" for auth is [`@basaltkit/auth-sqlite`](/reference/packages):
durable implementations of **all seven** auth stores — users, sessions, refresh
tokens, one-time (verify/reset) tokens, API keys, MFA enrolment and token
versions — on Node's built-in `node:sqlite`. No ORM, no migration tool, no
separate service, zero external dependencies.

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { sqliteAuthStores } from '@basaltkit/auth-sqlite'

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
      // tokenVersions: s.tokenVersions, // opt-in: instant access-token revocation
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
})
```

`sqliteAuthStores()` opens (or creates) the file, applies an idempotent schema,
and hands back every store named to slot straight into the plugins — plus the
raw `db` handle. The rest of your auth code is untouched: these classes
implement the same contracts as the in-memory stores. Each store is also
exported on its own (`SqliteUserSource`, …) so you can mix backends.
`tokenVersions` has **no in-memory default** — auth only checks token versions
when you pass a store, at the cost of one read per verified request.

::: tip Node version
`node:sqlite` is stable and flag-free on **Node 24**; on Node 22.x run with
`--experimental-sqlite`. Requires Node 22.5+.
:::

SQLite is a genuinely production-grade default for single-node apps. Run
multiple instances that must share session state? Point sessions/refresh tokens
at Redis and keep users in your primary database — the contracts make that a
per-store choice.

## Auth on Postgres/MySQL — `@basaltkit/auth-prisma`

When your app already runs on a real database, [`@basaltkit/auth-prisma`](/reference/packages)
gives you the same seven auth stores backed by **Prisma**. You bring a generated
`PrismaClient` whose schema includes the `Auth*` models (the package ships a
reference `schema.prisma`); the stores only touch those delegates, so they layer
onto your existing client without owning your schema or connection.

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
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

Don't hand-copy the models — run **`basalt prisma:sync`**. It discovers every
installed `@basaltkit/*-prisma` package and merges the models they need into your
`prisma/schema.prisma` (interactive by default; `--yes` adds them all,
`--only=auth,teams` restricts, `--push` applies immediately):

```bash
pnpm basalt prisma:sync --push        # add missing models + create the tables
```

It's idempotent and never touches your own models. And if you wire a `*-prisma`
store before its models exist, the store now fails fast with a clear message
naming the missing model and pointing you here — no more cryptic
`reading 'create' of undefined`.

Otherwise, copy the reference models into your `schema.prisma`, `prisma migrate`, and go.
For **database-per-tenant** — every domain isolated in its own database or schema
with no per-store tenant filtering — pair it with `@basaltkit/prisma` and route the
stores through the active tenant's client. That end-to-end setup has its own
guide: [Database-per-tenant](/guide/database-per-tenant).

::: tip Which one?
`@basaltkit/auth-sqlite` for a single node with zero dependencies;
`@basaltkit/auth-prisma` when you already run Postgres/MySQL or need multiple
instances to share one database. Both implement the identical store contracts,
so switching is a one-line change.
:::

## Teams — `@basaltkit/teams-sqlite` / `@basaltkit/teams-prisma`

`@basaltkit/teams` keeps memberships and invitations behind the same kind of store
contract, and ships the same two durable backends — so team rosters and pending
invitations survive a restart too:

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { sqliteTeamsStores } from '@basaltkit/teams-sqlite'   // single-node, zero-dep
// import { prismaTeamsStores } from '@basaltkit/teams-prisma' // Postgres/MySQL

const t = sqliteTeamsStores('./data/teams.db')
teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
```

`prismaTeamsStores(prisma)` is the drop-in Prisma equivalent (bring a client with
the `Team*` models from the bundled reference schema). Same "which one?" trade-off
as auth: SQLite for a single node, Prisma when you already run a database or need
to share it across instances. They can share one handle with the auth stores.

## Subscriptions — `@basaltkit/subscriptions-sqlite` / `@basaltkit/subscriptions-prisma`

Billing has three stores — the **subscription** record, **usage** counters, and
**webhook** idempotency — and both durable backends implement all three:

```ts
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { sqliteSubscriptionsStores } from '@basaltkit/subscriptions-sqlite'   // single-node
// import { prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma' // Postgres/MySQL

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
`@basaltkit/subscriptions` still ships `RedisUsageStore` and `RedisWebhookStore` —
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
import { auditPlugin } from '@basaltkit/audit'
import { sqliteAuditStore } from '@basaltkit/audit-sqlite'          // single-node
// import { prismaAuditStore } from '@basaltkit/audit-prisma'       // Postgres/MySQL

auditPlugin({ store: sqliteAuditStore('./data/audit.db').store })
```

Each returns `{ store }` (SQLite also exposes the shared `db`) named for its
plugin: `commentsPlugin({ store })`, `auditPlugin({ store })`,
`activityPlugin({ store })`, `notificationsPlugin({ inApp: store })`. Queries keep
the in-memory semantics — newest-first, tenant/recipient scoping, the audit
event-wildcard, unread filtering — now durable. JSON payloads (audit `payload`,
activity `properties`, notification `data`) are stored as text and round-trip
unchanged.

`@basaltkit/permissions` follows the same shape: `permissionsPlugin({ store })`
takes the durable `AccessStore` (role assignments and grants, scoped), so RBAC
state survives a restart too. `@basaltkit/flags` needs no backend — feature flags
are declared in code and evaluated deterministically, with nothing to persist.

## Tenancy — `@basaltkit/tenancy-sqlite` / `@basaltkit/tenancy-prisma`

The tenant registry is the foundation of a multi-tenant app, yet `@basaltkit/tenancy`
ships only `MemoryTenantSource` by default — every tenant is forgotten on restart.
Both durable backends implement the same `TenantSource` contract, so the registry
(and each tenant's custom domains) becomes persistent:

```ts
import { tenancyPlugin, subdomainResolver } from '@basaltkit/tenancy'
import { sqliteTenantSource } from '@basaltkit/tenancy-sqlite'   // single-node, zero-dep
// import { prismaTenantSource } from '@basaltkit/tenancy-prisma' // Postgres/MySQL

const tenants = sqliteTenantSource('./data/tenants.db')
await tenants.save({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'localhost' })] })
```

A tenant is an **open record** (`{ id, ...anything }`), stored as JSON so any
per-tenant field round-trips unchanged; custom domains are normalized into an
indexed table so `findByDomain` (the domain resolver) is a keyed lookup. Both add
write methods — `save` (upsert + replace the domain set), `remove` — and enforce
**globally-unique domains**: claiming one already owned by another tenant is
rejected, so routing stays unambiguous. `prismaTenantSource` ships a reference
`schema.prisma` picked up by `basalt prisma:sync`; same "which one?" trade-off as
auth — SQLite for a single node, Prisma when you already run a database.

## Events outbox — `@basaltkit/events-sqlite` / `@basaltkit/events-prisma`

The transactional outbox writes each domain event to a durable
store, then a relay delivers it to the outside world (webhooks, Kafka…) and marks
it published — delivery is **at-least-once and survives a crash**. That guarantee
only holds if the store is durable, yet `@basaltkit/events` defaults to
`MemoryOutboxStore`, which loses every un-relayed event on restart. Both backends
implement the same `OutboxStore` contract:

```ts
import { outboxPlugin } from '@basaltkit/events'
import { sqliteOutboxStore } from '@basaltkit/events-sqlite'   // single-node, zero-dep
// import { prismaOutboxStore } from '@basaltkit/events-prisma' // Postgres/MySQL

const outbox = sqliteOutboxStore('./data/outbox.db')
outboxPlugin({
  store: outbox.store,
  captureEvents: ['order.*', 'invoice.*'], // recorded durably as they fire
  dispatch: async (entry) => sendToWebhook(entry),
  intervalMs: 1000,
})
```

### Relay semantics

The relay is the part that decides whether "at-least-once" is real. Four
behaviours, all verifiable in `@basaltkit/events`:

- **Capture is awaited.** A `captureEvents` pattern subscribes on the
  `@basaltkit/events` bus, and the listener `await`s the outbox write. If that
  write fails, `emit()` fails (the bus aggregates listener failures into an
  `AggregateError`) instead of the event being silently dropped while the outbox
  promises at-least-once. The tenant is read from the ambient context
  (`ctx().tenant.id`), so an entry recorded inside a request is tenant-scoped
  automatically.
- **Overlapping ticks coalesce.** `flush()` returns the in-flight flush instead
  of re-selecting the batch, so a dispatch slower than `intervalMs` can't
  double-deliver its own entries.
- **Failures back off.** A failed entry is skipped by this process until its
  delay elapses: `delayMs · 2^(attempts-1)`, capped at `maxDelayMs`
  (`type: 'fixed'` keeps it constant, `backoff: false` retries every tick). The
  schedule is **process-local** — no schema change, and a restart forgets it, so
  the worst case is one early retry. Still at-least-once.
- **Dead entries are loud.** An entry that reaches `maxAttempts` is excluded
  from future `pending()` scans and reported once through `onDead(entry, error)`;
  it stays in the store with its `lastError` for inspection. Nothing deletes it
  for you.

::: warning Two different error callbacks
`onDead(entry, error)` fires for a **single entry** that exhausted its attempts.
`onFlushError(error)` fires when the **flush itself** failed at the store level —
`pending()` threw, the database is unreachable — so no entry was even selected.
Per-entry dispatch failures never reach `onFlushError`; they are recorded on the
entry via `markFailed`. Both default to `console.error`
(`[basalt:outbox] entry "…" is dead after N attempts:` and
`[basalt:outbox] flush failed:`) and neither may throw. The timer path and the
shutdown drain both route through `onFlushError`, which is what keeps a database
outage from becoming an unhandled rejection that kills the process.
:::

```ts
outboxPlugin({
  store: outbox.store,
  dispatch: (entry) => sendToWebhook(entry),
  captureEvents: ['order.*', 'invoice.*'],
  intervalMs: 1000,
  batchSize: 50,
  maxAttempts: 10,
  backoff: { type: 'exponential', delayMs: 1000, maxDelayMs: 60_000 },
  onDead: (entry, error) => alerts.page('outbox entry dead', { id: entry.id, event: entry.event, error }),
  onFlushError: (error) => logger.error({ err: error }, 'outbox flush failed'),
})
```

`outboxPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `dispatch` | `(entry: OutboxEntry) => void \| Promise<void>` | — (**required**) | Delivers a committed entry to the outside world; throwing marks the entry failed and schedules a retry |
| `store` | `OutboxStore` | `new MemoryOutboxStore()` | Where entries live — the whole guarantee depends on this being durable |
| `captureEvents` | `string[]` | `[]` | Event patterns recorded automatically (`'order.*'`); a non-empty list makes the plugin depend on `basalt:events` |
| `intervalMs` | `number` | — (manual) | Relay poll interval. Omit to flush yourself via the `OUTBOX` token; the timer is `unref()`ed so it never keeps the process alive |
| `batchSize` | `number` | `50` | Entries selected per flush — raise for throughput, lower to bound one tick's work |
| `maxAttempts` | `number` | `10` | Attempts before an entry is left dead and reported to `onDead` |
| `backoff` | `OutboxBackoff \| false` | `{ type: 'exponential', delayMs: 1000, maxDelayMs: 60_000 }` | Retry pacing for failed entries; `false` retries on every tick |
| `onDead` | `(entry, error) => void` | `console.error` | One entry exhausted `maxAttempts` — page someone, this is a lost external delivery |
| `onFlushError` | `(error) => void` | `console.error` | The flush failed at the store level (timer tick or shutdown drain). Must never throw |
| `now` | `() => number` | `Date.now` | Injectable clock (tests) |

`backoff` (`OutboxBackoff`):

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `delayMs` | `number` | `1000` | Base delay before retrying a failed entry |
| `type` | `'fixed' \| 'exponential'` | `'exponential'` | Doubling vs. constant retry spacing |
| `maxDelayMs` | `number` | `60_000` | Ceiling for the exponential delay |

The SQLite backend keeps a partial index on un-published rows so the relay's
"what's pending?" scan stays cheap. The Prisma backend puts the outbox in your
primary database — the point of the pattern: enqueue the event **in the same
transaction** as the state change, and the two can never disagree. `pending`,
attempt ceilings and `markPublished`/`markFailed` keep the in-memory semantics,
now durable.

now durable.

## Outbound webhooks — `@basaltkit/webhooks-sqlite` / `@basaltkit/webhooks-prisma`

`@basaltkit/webhooks` keeps its endpoint subscriptions behind a `WebhookStore`, and
defaults to `MemoryWebhookStore` — so a redeploy forgets every registered
endpoint and events silently stop being delivered. Both durable backends persist
the subscriptions:

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { sqliteWebhookStore } from '@basaltkit/webhooks-sqlite'   // single-node, zero-dep
// import { prismaWebhookStore } from '@basaltkit/webhooks-prisma' // Postgres/MySQL

const webhooks = sqliteWebhookStore('./data/webhooks.db')
webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

Each endpoint (URL, event patterns, optional tenant, per-endpoint secret and
`active` flag) survives a restart. Event-pattern matching (`*`, `prefix.*`,
exact) reuses `matchesEvent`, so `forEvent` behaves identically to the memory
store — the delivery/retry logic is unchanged, only the subscription list is now
durable.

## Redis-backed stores

Several packages already ship Redis implementations for the state that benefits
most from being shared across instances:

| Concern | In-memory (default) | Durable / shared |
| --- | --- | --- |
| Cache | `MemoryCacheDriver` | `RedisCacheDriver` (`@basaltkit/cache`), tiered (`@basaltkit/cache-tiered`) |
| Usage metering | `MemoryUsageStore` | `RedisUsageStore` — atomic `consume()` via Lua |
| Webhook idempotency | `MemoryWebhookStore` | `RedisWebhookStore` — `SET NX EX` across restarts |
| Rate limiting | `MemoryRateLimitStore` | `RedisRateLimitStore` (`@basaltkit/http`) — one atomic counter shared across instances |
| Request idempotency | `MemoryIdempotencyStore` | `RedisIdempotencyStore` (`@basaltkit/fastify`) — replays a cached response across instances |
| Queues | in-memory driver | RabbitMQ / Kafka / SQS driver packages |
| Search | `MemorySearchDriver` | Meilisearch / Postgres driver packages |
| Storage | local disk | S3 / GCS / Azure driver packages |

## Writing your own store

A store is a handful of async methods. To back auth users with your existing
database, implement `UserSource`:

```ts
import type { UserSource, AuthUser, UserPatch } from '@basaltkit/auth'

class PrismaUserSource implements UserSource {
  async findByEmail(email: string): Promise<AuthUser | null> { /* … */ }
  async findById(id: string): Promise<AuthUser | null> { /* … */ }
  async create(data: { email: string; passwordHash: string }): Promise<AuthUser> { /* … */ }
  async update(id: string, patch: UserPatch): Promise<AuthUser | null> { /* … */ }
}
```

`@basaltkit/auth-sqlite` and `@basaltkit/auth-prisma` are compact, fully-tested
references for all six auth stores — read either when you build one for another
database or ORM. The same approach applies to every other store contract in the
stack.

## Options reference

Every durable backend is a **factory**, not a plugin — you call it once at
startup and pass the result into the plugin that owns the domain. The two
families have one signature each:

| Family | Signature | Returns |
| --- | --- | --- |
| `sqlite*` | `(dbOrLocation: DatabaseSync \| string = ':memory:')` | `{ db, …stores }` — the raw `node:sqlite` handle plus one store per contract |
| `prisma*` | `(client: PrismaClient)` | `{ …stores }` — no handle; you already own the client |

Passing a **path** opens (or creates) the file and applies the schema; passing
an existing `DatabaseSync` migrates that handle instead, which is how several
domains share one file. `':memory:'` is the default, which is why an
un-configured factory is still safe in tests.

| Domain | SQLite factory | Prisma factory | Feeds |
| --- | --- | --- | --- |
| Auth | `sqliteAuthStores()` | `prismaAuthStores(client)` | `authPlugin({ users, sessions, refreshTokens, tokens, mfa, tokenVersions })`, `apiKeysPlugin({ store, users })` |
| Teams | `sqliteTeamsStores()` | `prismaTeamsStores(client)` | `teamsPlugin({ memberships, invitations })` |
| Subscriptions | `sqliteSubscriptionsStores()` | `prismaSubscriptionsStores(client)` | `subscriptionsPlugin({ store, usage, webhooks })` |
| Payments | `sqlitePaymentStores()` | `prismaPaymentStores(client)` | the payments ledger + recurring stores |
| Comments | `sqliteCommentsStore()` | `prismaCommentsStore(client)` | `commentsPlugin({ store })` |
| Audit | `sqliteAuditStore()` | `prismaAuditStore(client)` | `auditPlugin({ store })` |
| Activity | `sqliteActivityStore()` | `prismaActivityStore(client)` | `activityPlugin({ store })` |
| Notifications | `sqliteInAppStore()` | `prismaInAppStore(client)` | `notificationsPlugin({ inApp: store })` |
| Permissions | `sqliteAccessStore()` | `prismaAccessStore(client)` | `permissionsPlugin({ store })` |
| Tenancy | `sqliteTenantSource()` | `prismaTenantSource(client)` | `tenancyPlugin({ source })` — returns the source itself, not `{ store }` |
| Events outbox | `sqliteOutboxStore()` | `prismaOutboxStore(client)` | `outboxPlugin({ store })` |
| Webhooks | `sqliteWebhookStore()` | `prismaWebhookStore(client)` | `webhooksPlugin({ store })` |

Each package also exports `openXDatabase(location)` and `migrate(db)` if you
want to control opening and migration yourself, and every individual store class
(`SqliteUserSource`, `PrismaAuditStore`, …) takes a `DatabaseSync` /
`PrismaClient` in its constructor — so you can mix backends per store.

The only backend with behavioural options of its own is the outbox relay; its
tables are in **Relay semantics** above. Everything else is
configured on the plugin that consumes it — see [Auth](/guide/auth),
[Teams](/guide/teams), [Billing](/guide/billing), [Tenancy](/guide/tenancy) and
[Webhooks](/guide/webhooks).

## Failure modes & troubleshooting

| Error | Code | When |
| --- | --- | --- |
| `Error: @basaltkit/<pkg>-prisma: the Prisma client has no <model> model.` | — | A `prisma*` factory ran against a client whose schema lacks the models. Run `basalt prisma:sync --push`, then `prisma generate`. Lazy/proxy clients (database-per-tenant) skip the check and fail at first use instead |
| `Error: @basaltkit/tenancy-prisma: domain "…" is already owned by tenant "…".` | — | `save()` tried to claim a custom domain another tenant owns. Domains are globally unique so routing stays unambiguous; the whole save is rejected before any write. The SQLite source enforces the same rule with a PRIMARY KEY constraint, inside a transaction that rolls back |
| `AggregateError` from `bus.emit(...)` | — | A `captureEvents` outbox write failed. The capture is awaited on purpose — the emitter must see the failure rather than believe a lost event was recorded |
| `EventValidationError` | `EVENT_INVALID` | The event's schema rejected the payload before any listener (including the outbox capture) ran |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | `OUTBOX` (or any store token) resolved without the plugin that registers it |
| `ERR_UNKNOWN_BUILTIN_MODULE` on `import 'node:sqlite'` | — | A `*-sqlite` package on Node 22.x without `--experimental-sqlite`. Use Node 24, or add the flag; the packages declare `engines.node >= 22.5.0` |

- **"It worked in dev and forgot everything after the deploy"** — a store is
  still on its in-memory default. The defaults are silent by design; grep your
  `createApp` for plugins you never passed a store to, and work down the
  checklist below.
- **Outbox entries pile up unpublished** — either no relay is running
  (`intervalMs` unset and nothing calls `OUTBOX.flush()`), or every entry is
  dead. Dead entries are excluded from `pending()`, so the table grows while the
  relay reports nothing to do: check `lastError` and whether `onDead` fired.
- **Events are recorded but never delivered after a redeploy** — the outbox
  store is durable but the **webhook subscriptions** aren't. `MemoryWebhookStore`
  forgets every registered endpoint, so delivery stops silently.
- **`SQLITE_BUSY` / lock contention under load** — one SQLite file is one
  writer. That is the trade-off for zero dependencies; move the hot domain to
  Prisma (or Redis, for cache/usage/idempotency) when a single writer stops
  being enough.
- **A durable store still returns nothing for a tenant** — the store is durable,
  not tenant-routed. For database-per-tenant you must route it through the
  active tenant's client; see [Database-per-tenant](/guide/database-per-tenant).

## What to do before going to production

- Replace in-memory **auth** stores with `@basaltkit/auth-sqlite` (or your own DB).
- Move **cache**, **usage metering** and **webhook idempotency** to Redis if you
  run more than one instance.
- Point **queues**, **search** and **storage** at their production drivers.

See [Going to Production](/guide/production) for the full checklist.
