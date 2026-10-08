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

It's idempotent and never touches your own models. When your `datasource` is
`mysql` it copies each package's `schema.mysql.prisma` variant instead — see
[MySQL](#mysql). And if you wire a `*-prisma`
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

### Prisma with pnpm: the generated client

Prisma 7 needs an explicit generator `output`, and where it points decides
whether the app runs on plain `node` after a build. What create-basalt scaffolds
(and what to copy into an older app):

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../generated/prisma"   // outside src/: tsc never copies these .js files
}
```

```json
{
  "imports": { "#db/*": "./generated/prisma/*" },
  "dependencies": {
    "@prisma/client": "^7.10.0",
    "@prisma/client-runtime-utils": "^7.10.0"
  }
}
```

```ts
// src/db.ts — the same specifier resolves from src/ (tsx, vitest) and dist/src/ (node)
import { PrismaClient } from '#db/client.js'
```

- **Outside `src/`.** A client generated under `src/generated` type-checks and
  runs under tsx, but `tsc` emits only what it compiles — the generated `.js`
  files never reach `dist/`, and `node dist/src/server.js` fails with
  `ERR_MODULE_NOT_FOUND`. The `imports` alias avoids both a copy script and a
  relative path that differs between `src/` and `dist/src/`.
- **`@prisma/client-runtime-utils` as a direct dependency.** The generated
  `runtime/client.js` requires it by name. Under pnpm it is only a transitive
  dependency of `@prisma/client`, kept in the virtual store where a file in your
  project cannot reach it — so declare it, with the same range as
  `@prisma/client`. No `publicHoistPattern` or `node-linker=hoisted` needed.
- **Approve the CLI's build scripts.** pnpm 11 fails an install while a
  dependency's build is unapproved; the scaffold's `pnpm-workspace.yaml` lists
  `prisma` and `@prisma/engines` under `allowBuilds`.

`create-basalt doctor` flags a client generated under `src/` and a missing
`@prisma/client-runtime-utils`; `create-basalt update` adds the dependency and
prints the move. The image itself is covered in
[Going to production](/guide/production#build-ship).

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
| Permissions | `AccessStore`, `TemporaryGrantStore`, `DelegationStore` | `sqliteAccessStore()` | `prismaAccessStore(prisma)` |

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
state survives a restart too. The same factories also return durable
`temporaryGrants` and `delegations` stores — pass them to keep time-boxed grants
(`grantTemporarily()`) and delegations (`delegate()`) across restarts and
instances: `permissionsPlugin({ store: p.store, temporaryGrants: p.temporaryGrants,
delegations: p.delegations })`. On Prisma they need the `PermTemporaryGrant` and
`PermDelegation` models (`basalt prisma:sync`), looked up on first use — an app
that does not wire them needs neither. Expired rows are inert; delete them with
`pruneExpired()` from a scheduled job. `@basaltkit/flags` needs no backend — feature flags
are declared in code and evaluated deterministically, with nothing to persist.

### Which hooks are audited {#which-hooks-are-audited}

`auditPlugin` records lifecycle hooks matching `auth:**`, `billing:**`,
`tenancy:created` and `permission:**`, **except** `auth:apikey_rejected`: it
fires for every request that presents a dead API key, before anyone is
authenticated, so recording it let any anonymous client append to a tenant's
(serialized, hash-chained) trail as fast as it could send requests.

`hooks` takes a list (the include set) or `{ include, exclude }`. A hook is
recorded when it matches an `include` pattern and no `exclude` pattern; without
`exclude`, the default excludes (`DEFAULT_AUDIT_HOOK_EXCLUDES`) apply. A hook
named **exactly** in `include` is always recorded — that is how you opt one back
in:

```ts
auditPlugin({ hooks: ['auth:**', 'auth:apikey_rejected'] })               // record rejections too
auditPlugin({ hooks: { include: ['auth:**', 'billing:**'], exclude: ['auth:login'] } })
auditPlugin({ hooks: { include: ['auth:**'], exclude: [] } })             // no default excludes
```

If you record `auth:apikey_rejected`, throttle it yourself (its payload carries
the key's display `prefix` and the client `ip` for that).

### Verifiable audit trail

Both audit stores support a **tamper-evident** trail and the request context:

```ts
auditPlugin({
  store: prismaAuditStore(prisma).store,
  integrity: 'hash-chain',   // or { mode: 'hash-chain', key: process.env.AUDIT_CHAIN_KEY! } (HMAC)
  requestContext: true,      // record ip + user-agent — personal data, see below
})
```

Each entry is linked to the previous one of its tenant's chain (`seq`, `prevHash`,
`hash` = SHA-256, or HMAC-SHA256 under a key, over a canonical serialization), with
one chain per tenant plus a system chain. The hash names its algorithm and key id
(`v2:hmac-sha256:<keyId>:<hex>`), so a key can be rotated without breaking
history: sign with the new `key`/`keyId` and keep the old one in `verifyKeys` —
`verify` picks each entry's key by its id. Legacy (bare 64-hex) hashes written by
earlier releases keep verifying under any key held. The hash column needs up to 144
characters (it fits the MySQL preset's `VARCHAR(191)`).
`audit.verify({ tenantId, from?, to? })` — or `basalt audit:verify
[--tenant=<id> | --all]` — detects edited, deleted, reordered and forged rows. Both
stores put a **unique constraint on `(chain, seq)`**, so replicas appending at the
same time retry instead of forking a chain. Rows written before `integrity` was
enabled are reported as *unchained*, not broken; any other row outside the chain
(written after it began, or with a `seq` under a missing or foreign chain name)
fails the verification and is listed in `unverified` — use
`trail({ chainedOnly: true })` for an evidence read. Deleting the tail leaves no
gap: pass a head recorded elsewhere as `verify({ expectedHead })` (or
`--expected-head=<seq>:<hash>`) to detect truncation. `--all` also checks
tenants that have rows but no chain (their rows written after integrity began
fail as `unchained-entry`); `--all=true` is read as `--all`, and an unrecognised
value is an error. An entry signed by a key id the verifier does not hold fails
as `unknown-key`, and a second row at one `seq` fails as `sequence-duplicate`
wherever it falls — page boundaries included, for a custom store without the
unique constraint.

`requestContext: true` adds an HTTP enricher (fastify, express and hono alike) and
stores the client `ip` and `userAgent`. The IP is PII: with
`createPiiMinimizingRedactor({ key })` it is stored as a pseudonym.

SQLite migrates the new columns automatically; for Prisma, add them to the model
and migrate first (the [`@basaltkit/audit-prisma` README](https://github.com/basaltkit/basalt/tree/main/packages/audit-prisma#upgrading-from-11)
has the SQL). Then make the database enforce append-only too:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_entries" FROM app_role;
```

#### Personal data per event (`fieldPolicies`)

The trail is append-only and the hash chain covers each payload, so a value
that reaches it cannot be erased later without breaking `verify`. Keep personal
data out at write time. The redactors work on key names and value shapes
(`password`, an email-looking string); they cannot know that the `notes` of one
event is health data. Declare that per event:

```ts
auditPlugin({
  integrity: 'hash-chain',
  fieldPolicies: {
    'customer.created': { omit: ['notes', 'address.street'], pseudonymize: ['email', 'fullName'] },
    'order.placed': { pseudonymize: ['items[].buyer.phone'] },
  },
  fieldPolicyKey: process.env.AUDIT_PII_KEY!, // >= 128 bits
})
```

- Keys are exact event or hook names (no wildcards). Paths are dotted; arrays are
  walked transparently, and `items[].x` spells that out.
- `omit` removes the field. `pseudonymize` replaces every scalar under it with a
  keyed HMAC pseudonym (`pii_<hex>`), so entries stay correlatable. A path in
  both is omitted.
- The policy runs on `record()`, captured hooks and events, **before** the
  redactor and before hashing, on a copy (your object is never mutated).
- Use the same key as `createPiiMinimizingRedactor({ key })` to get the same
  pseudonyms. Without `fieldPolicyKey`, a random per-process key is used and a
  warning is logged once.
- Policies are validated at configuration time: an unknown option, an empty or
  prototype (`__proto__`, `constructor`) segment, or a path deeper than 8
  segments throws a `TypeError`.

Erasing a value that is already in the chain (a "right to erasure" request) is
not supported yet; it needs a chain format that hashes a payload digest, which
is planned as a separate RFC.

#### Recording outside a request (jobs, scripts)

An entry takes its `actorId` and `tenantId` from the active context. Outside a
request there is none, so `audit.record()` lands in the **system chain** with no
actor — unless you give it one:

- **Queue jobs** need nothing: `@basaltkit/queue` captures the dispatcher's
  tenant and user and restores them around the handler, so `record()` inside a
  job is attributed like it was in the request that dispatched it.
- **Scripts and CLI commands** wrap the work in the context they act for:

  ```ts
  import { runWithContext } from '@basaltkit/core'

  await runWithContext({ tenant: { id: 'acme' }, user: { id: 'ops:backfill' } }, () =>
    audit.record('invoice.backfilled', { count }),
  )
  ```

- **A single entry** can pass an explicit scope as the third argument:

  ```ts
  await audit.record('report.generated', { rows }, { tenantId: 'acme', actorId: 'job:nightly' })
  ```

  The entry joins that tenant's chain (`t:acme`), so `verify({ tenantId: 'acme' })`
  covers it. The scope can only **narrow**: inside a context with a tenant (or a
  user), a different `scope.tenantId` (or `scope.actorId`) throws a `TypeError`
  rather than writing into another tenant's chain. Both values must be non-empty
  printable strings of at most 256 characters. Never forward client input into it.

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
write methods — `save` (upsert + sync the domain set), `remove` — and enforce
**globally-unique domains**: claiming one already owned by another tenant is
rejected, so routing stays unambiguous. `prismaTenantSource` ships a reference
`schema.prisma` picked up by `basalt prisma:sync`; same "which one?" trade-off as
auth — SQLite for a single node, Prisma when you already run a database.

Each package also ships the durable `DomainStore` for verified custom domains
(`CustomDomains`), on the same table: `prismaDomainStore(prisma)` /
`sqliteDomainStore(tenants.db)`. Domains claimed through it survive every
`save()`, and `findByDomain` resolves them only once verified — see
[a durable domain store](/guide/tenancy#a-durable-domain-store).

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

### Write the event in your transaction

The guarantee — the event exists **if and only if** the state change committed —
needs the entry written *inside* the business transaction. Pass the transaction
handle as `tx` to `enqueue`; the store writes through it, so a rollback removes
both:

```ts
const outbox = app.container.get(OUTBOX)

// Prisma: the interactive-transaction client
await prisma.$transaction(async (tx) => {
  await tx.order.update({ where: { id }, data: { status: 'paid' } })
  await outbox.enqueue('order.paid', { id }, { tenantId, tx })
})

// SQLite: the DatabaseSync running BEGIN … COMMIT (same file as the outbox)
db.exec('BEGIN')
db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`).run(id)
await outbox.enqueue('order.paid', { id }, { tx: db })
db.exec('COMMIT')
```

`captureEvents` is convenient but **not** transactional: it records the event
when `emit()` runs, outside your transaction. Use an explicit
`enqueue(…, { tx })` for events that must never diverge from the data.

### Several relays (replicas)

With one relay per replica, two relays would read the same pending rows. A store
that implements `claim` prevents the double dispatch: after selecting a batch the
relay **claims** it with one conditional update (`lockedUntil`/`lockedBy`, a
lease of `claimLeaseMs`, default 5 min) and dispatches only the rows it won;
`pending()` hides rows another relay holds. `@basaltkit/events-sqlite` always
claims (its `migrate()` adds the columns); `@basaltkit/events-prisma` claims with
`prismaOutboxStore(prisma, { claim: true })` — add the `lockedUntil` / `lockedBy`
columns first (`basalt prisma:sync`, then migrate). It uses plain model queries,
not `FOR UPDATE SKIP LOCKED`: portable across providers, allowed by the tenancy
extension's raw-query guard, and a relay that crashes mid-dispatch only holds its
rows until the lease expires. Delivery stays at-least-once.

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
  schedule is **process-local** — a restart forgets it, so the worst case is one
  early retry — unless the store claims: then the retry time is also written to
  the row, so every replica honours it. Still at-least-once. Entries in backoff
  never fill the batch — the relay over-fetches past them — so one failing
  downstream (e.g. one tenant's endpoint) can't starve newer entries.
- **A slow dispatch doesn't serialize the batch.** Up to `concurrency` entries
  (default 8) are dispatched in parallel; set `concurrency: 1` for strictly
  sequential delivery.
- **Tenants are served fairly.** When one tenant's backlog fills a whole page,
  the relay queries again excluding the tenants already seen (the store's
  `pending(limit, maxAttempts, filter)`), then interleaves the batch round-robin
  by tenant — each tenant stays FIFO. One tenant never has more than
  `tenantConcurrency` dispatches in flight, and a flush waits at most
  `dispatchTimeoutMs` per entry: a slower dispatch continues *detached* (not
  cancelled, not re-sent) and its outcome is recorded when it settles. A tenant
  with a hanging downstream can't starve the others, however much it emits.
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
| `store` | `OutboxStore` | `new MemoryOutboxStore()` | Where entries live — the whole guarantee depends on this being durable. The in-memory store keeps the last 1000 published entries (`new MemoryOutboxStore({ retainPublished })`) |
| `captureEvents` | `string[]` | `[]` | Event patterns recorded automatically (`'order.*'`); a non-empty list makes the plugin depend on `basalt:events` |
| `intervalMs` | `number` | — (manual) | Relay poll interval. Omit to flush yourself via the `OUTBOX` token; the timer is `unref()`ed so it never keeps the process alive |
| `batchSize` | `number` | `50` | Entries selected per flush — raise for throughput, lower to bound one tick's work |
| `maxAttempts` | `number` | `10` | Attempts before an entry is left dead and reported to `onDead` |
| `backoff` | `OutboxBackoff \| false` | `{ type: 'exponential', delayMs: 1000, maxDelayMs: 60_000 }` | Retry pacing for failed entries; `false` retries on every tick |
| `concurrency` | `number` | `8` | Entries of one flush dispatched in parallel, so one hanging downstream holds a slot, not the batch. `1` = sequential |
| `tenantConcurrency` | `number` | `ceil(concurrency / 2)` | Most dispatches one tenant (or all tenant-less entries together) may have in flight, across flushes |
| `dispatchTimeoutMs` | `number \| false` | `10_000` | Max wait per entry before the flush moves on; the dispatch continues detached and its outcome is still recorded. `false` waits indefinitely |
| `onDead` | `(entry, error) => void` | `console.error` | One entry exhausted `maxAttempts` — page someone, this is a lost external delivery |
| `onFlushError` | `(error) => void` | `console.error` | The flush failed at the store level (timer tick or shutdown drain). Must never throw |
| `claimLeaseMs` | `number` | `300_000` | Claiming stores (several relays): how long a relay's claim on an entry lasts. Past it, a relay that died mid-dispatch loses the entry to another relay. Must exceed your slowest dispatch |
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

## MySQL

The `*-prisma` reference schemas are written for PostgreSQL, and a bare
`String` means `TEXT` there — and on SQLite. **On MySQL Prisma maps it to
`VARCHAR(191)`**, and a MySQL server outside strict mode truncates a longer
value with only a warning: the write succeeds and the value read back is not
the one written. A webhook URL then delivers somewhere else, a file `path` no
longer names the stored object, a JSON payload stops parsing, and a truncated
audit payload or hash **breaks the hash chain** for good.

Three things close it:

1. **Use the MySQL schema variant.** Each package ships
   `schema.mysql.prisma` next to `schema.prisma`: the same models, with the
   free-text columns widened (`@db.Text`, `@db.MediumText` for JSON payloads,
   `@db.VarChar(255)` for a DNS name or a content type) and the keys left at
   `VARCHAR(191)` so they can still be indexed. `basalt prisma:sync` picks it
   automatically when your `datasource` says `provider = "mysql"`, and warns
   about a package that has none. MySQL has no `String[]`, so the variants of
   `@basaltkit/comments-prisma` (`mentions`) and `@basaltkit/auth-prisma`
   (`scopes`, `recoveryCodes`) store those lists as `Json`.
2. **Turn on the guard.** Pass `{ columnLimits: 'mysql' }` to the factory, and
   the store measures every string against its column before writing — in
   characters for `VARCHAR(n)`, in UTF-8 bytes for the `TEXT` family — and
   throws `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`, status 422) instead of
   letting the database cut it. Nothing is written; for the audit trail the
   chain stays verifiable.
3. **Run MySQL in strict mode** (`sql_mode` with `STRICT_TRANS_TABLES`, the
   default since 5.7), so the server itself refuses what no guard covers — a
   model of your own, a raw query.

```ts
const audit = prismaAuditStore(prisma, { columnLimits: 'mysql' })
const webhooks = prismaWebhookStore(prisma, { columnLimits: 'mysql' })
const files = prismaFilesStore(prisma, { columnLimits: 'mysql' })
```

`'mysql'` is the preset matching the shipped `schema.mysql.prisma`; each package
exports it (`auditMysqlColumnLimits`, `webhooksMysqlColumnLimits`, …). If you
widen a column yourself, spread the preset and raise that one limit — a number
is a limit in characters, `{ bytes: n }` in bytes:

```ts
import { auditMysqlColumnLimits, prismaAuditStore } from '@basaltkit/audit-prisma'

prismaAuditStore(prisma, {
  columnLimits: { AuditEntry: { ...auditMysqlColumnLimits.AuditEntry, event: 500 } }, // event @db.VarChar(500)
})
```

Leave `columnLimits` unset on PostgreSQL and SQLite: nothing is checked, and
nothing changes. The option is on `activity-`, `audit-`, `auth-` (every store),
`comments-`, `events-`, `files-` (both stores), `notifications-`,
`permissions-`, `subscriptions-` (both factories), `teams-` (both stores),
`tenancy-` and `webhooks-prisma` — every `*-prisma` package now ships a MySQL
variant. In `teams-prisma` it widens the invitation `email` to `VARCHAR(254)`,
the longest valid address; the permission and team keys stay `VARCHAR(191)`.
In `auth-prisma` the user `email` is `VARCHAR(254)`; the password hash, sealed
TOTP secret, OIDC subject and passkey key material are `TEXT`; and
`scopes`/`recoveryCodes` are `Json` (MySQL has no scalar lists). One column is
shortened rather than refused: the outbox's `lastError`, which is diagnostic —
refusing it would stop `markFailed` from counting the attempt — is cut to fit
and marked `…[truncated]`.

## Redis-backed stores

Several packages already ship Redis implementations for the state that benefits
most from being shared across instances:

| Concern | In-memory (default) | Durable / shared |
| --- | --- | --- |
| Cache | `MemoryCacheDriver` (`@basaltkit/cache`) | `redisCache()` (`@basaltkit/cache-redis`), tiered (`@basaltkit/cache-tiered`) |
| Usage metering | `MemoryUsageStore` | `RedisUsageStore` — atomic `consume()` via Lua |
| Webhook idempotency | `MemoryWebhookStore` | `RedisWebhookStore` — `SET NX EX` across restarts |
| Rate limiting | `MemoryRateLimitStore` | `RedisRateLimitStore` (`@basaltkit/http`) — one atomic counter shared across instances |
| Request idempotency | `MemoryIdempotencyStore` | `RedisIdempotencyStore` (`@basaltkit/http`, any adapter) — replays a cached response across instances |
| Queues | in-memory driver | RabbitMQ / Kafka / SQS driver packages |
| Search | `MemorySearchDriver` | `MeilisearchDriver` (built in), `@basaltkit/search-postgres`, `@basaltkit/search-elasticsearch` |
| Storage | local disk | S3 / GCS / Azure driver packages |

## Writing your own store

A store is a handful of async methods. To back auth users with your existing
database, implement `UserSource`:

```ts
import type { UserSource, AuthUser, UserPatch, NewUser } from '@basaltkit/auth'

class PrismaUserSource implements UserSource {
  async findByEmail(email: string): Promise<AuthUser | null> { /* … */ }
  async findById(id: string): Promise<AuthUser | null> { /* … */ }
  async create(data: NewUser): Promise<AuthUser> { /* … persist data.emailVerified ?? false */ }
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
| `prisma*` | `(client: PrismaClient, options?)` | `{ …stores }` — no handle; you already own the client. `options.columnLimits` guards MySQL column widths ([MySQL](#mysql)) |

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
| Permissions | `sqliteAccessStore()` | `prismaAccessStore(client)` | `permissionsPlugin({ store, temporaryGrants, delegations })` |
| Tenancy | `sqliteTenantSource()` | `prismaTenantSource(client)` | `tenancyPlugin({ source })` — returns the source itself, not `{ store }` |
| Custom domains | `sqliteDomainStore(db)` | `prismaDomainStore(client)` | `new CustomDomains({ store })` — returns the store itself |
| Events outbox | `sqliteOutboxStore()` | `prismaOutboxStore(client, { claim? })` | `outboxPlugin({ store })` |
| Webhooks | `sqliteWebhookStore()` | `prismaWebhookStore(client)` | `webhooksPlugin({ store })` |

Each package also exports `openXDatabase(location)` and `migrate(db)` if you
want to control opening and migration yourself, and every individual store class
(`SqliteUserSource`, `PrismaAuditStore`, …) takes a `DatabaseSync` /
`PrismaClient` in its constructor — so you can mix backends per store.

The only backends with behavioural options of their own are the outbox's: the
relay's tables are in **Relay semantics** above, and `prismaOutboxStore` takes
`{ claim: true }` (see **Several relays**) — plus the MySQL `columnLimits`
guard every `prisma*` factory takes ([MySQL](#mysql)). Everything else is
configured on the plugin that consumes it — see [Auth](/guide/auth),
[Teams](/guide/teams), [Billing](/guide/billing), [Tenancy](/guide/tenancy) and
[Webhooks](/guide/webhooks).

## Failure modes & troubleshooting

| Error | Code | When |
| --- | --- | --- |
| `Error: @basaltkit/<pkg>-prisma: the Prisma client has no <model> model.` | — | A `prisma*` factory ran against a client whose schema lacks the models. Run `basalt prisma:sync --push`, then `prisma generate`. Lazy/proxy clients (database-per-tenant) skip the check and fail at first use instead |
| `Error: @basaltkit/tenancy-prisma: domain "…" is already owned by tenant "…".` | — | `save()` tried to claim a custom domain another tenant owns. Domains are globally unique so routing stays unambiguous; the whole save is rejected before any write. The SQLite source enforces the same rule with a PRIMARY KEY constraint, inside a transaction that rolls back |
| `ColumnLengthError: @basaltkit/<pkg>-prisma: <Model>.<column> is N characters, over its column limit of M.` | `COLUMN_LENGTH_EXCEEDED` | A store configured with `columnLimits` refused a value its MySQL column cannot hold. Nothing was written. Widen the column and raise the limit, or shorten the value — see [MySQL](#mysql) |
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
- For a compliance-grade **audit trail**, enable `integrity: 'hash-chain'`, revoke
  `UPDATE`/`DELETE` on `audit_entries`, and schedule `basalt audit:verify --all`
  ([above](#verifiable-audit-trail)).
- On **MySQL**, copy the `schema.mysql.prisma` variants, pass
  `{ columnLimits: 'mysql' }` to every `prisma*` factory, and keep the server in
  strict mode ([above](#mysql)) — otherwise long values are silently truncated.

See [Going to Production](/guide/production) for the full checklist.
