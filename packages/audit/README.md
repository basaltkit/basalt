<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/audit

Audit trail for Basalt applications: automatically records, in an immutable history, who did what and when — from lifecycle hooks, domain events, and manual records.

You need this module when you have to be able to answer questions like "who logged into this account?" or "who changed this billing plan?" — for security, support, or compliance reasons.

---

## What this module solves

**Auditing** is the systematic recording of relevant actions in a system: logins, billing changes, permission changes. Unlike technical logs (which are for developers and can be deleted), the audit trail is a business record: **append-only** (only added to, never altered or deleted) and enriched with the **actor** (who did it), the **tenant** (which organization it belongs to), and the **request** (requestId) — all captured automatically from the active context at record time.

The tedious part of auditing is remembering to record everywhere. This module solves that by hooking into what the application already emits: the `@basaltkit/core` lifecycle **hooks** (e.g. `auth:login`, `billing:subscribed`) and the `@basaltkit/events` **domain events** (e.g. `order.created`). You choose what gets recorded using wildcard patterns — by default, all `auth`, `billing`, `tenancy`, and `permission` activity (hooks) and **all** events.

Each entry is frozen (`Object.freeze`) — code can't tamper with the in-memory history, even by accident. To query, use `audit.trail()` with filters on event (with wildcards), tenant, actor, and date.

## Installation

```bash
pnpm add @basaltkit/audit
```

Depends on `@basaltkit/core` and `@basaltkit/events`. The default storage is in-memory (`MemoryAuditStore`) — for production you should provide a persistent `AuditStore` (see "Custom store").

## Get started in 5 minutes

**1. Register the plugin (along with the events plugin, if you use it):**

```ts
import { createApp } from '@basaltkit/core'
import { eventsPlugin } from '@basaltkit/events'
import { AUDIT, auditPlugin } from '@basaltkit/audit'

const app = await createApp({
  plugins: [eventsPlugin(), auditPlugin()],
}).boot()
```

**2. From here on, relevant hooks and events get recorded on their own.** For example, when the auth module emits the `auth:login` hook, an audit entry is created with the actor and tenant from context.

**3. Query the trail:**

```ts
const audit = app.container.get(AUDIT)

const trail = await audit.trail()               // everything, most recent first
const logins = await audit.trail({ event: 'auth:**' })
console.log(logins[0])
// {
//   id: '4f1c…', source: 'hook', event: 'auth:login',
//   payload: { user: { id: 'u1', email: 'a@b.c' } },
//   actorId: 'u1', tenantId: 'acme', requestId: 'req-1', at: 1754500000000
// }
```

**4. Manually record what hooks don't cover:**

```ts
await audit.record('data.export', { format: 'csv' })
```

## Usage guide

### Automatic hook capture

By default, hooks matching `auth:**`, `billing:**`, `tenancy:created`, or `permission:**` are recorded (not `tenancy:switched`, which fires on every request). You can replace the list:

```ts
import { auditPlugin } from '@basaltkit/audit'

auditPlugin({
  hooks: ['auth:**', 'billing:**', 'api-keys:**'], // replaces the defaults
})
```

Enrichment comes from the active context: `ctx().user.id` → `actorId`, `ctx().tenant.id` → `tenantId`, `ctx().requestId` → `requestId`.

### Automatic domain event capture

If the container has an `EventBus` (`@basaltkit/events` registered), the plugin subscribes to `**` and records events that match the patterns. By default it records **everything**; you can narrow or disable it:

```ts
auditPlugin({ events: ['order.**', 'invoice.**'] }) // only these
auditPlugin({ events: [] })                          // disable event capture
```

### Manual records

For actions that no hook/event covers:

```ts
import { runWithContext } from '@basaltkit/core'

await runWithContext({ user: { id: 'u1' }, tenant: { id: 'acme' } }, async () => {
  const entry = await audit.record('data.export', { format: 'csv' })
  // entry.source === 'manual', entry.actorId === 'u1', entry.tenantId === 'acme'
})
```

`record` returns the created entry (already frozen).

### Querying the trail

`trail(query)` returns entries **most recent first**:

```ts
await audit.trail({ event: 'auth:**' })         // wildcard over the name
await audit.trail({ tenantId: 'acme' })          // only for one tenant
await audit.trail({ actorId: 'u1' })             // only for one user
await audit.trail({ since: Date.now() - 86_400_000 }) // last 24h
await audit.trail({ limit: 50 })                 // at most 50
```

#### `trail()` vs `systemTrail()` — how the tenant scope is decided

`@basaltkit/audit` is a **general-purpose** package: it works with or without
`@basaltkit/tenancy`, and `trail()` is always the everyday read. What it does
when it can't resolve a tenant depends on whether the app is multi-tenant at all
— detected through tenancy's `tenancy:active` metadata marker, not an import.

| Situation | `trail()` |
|---|---|
| Tenant in `ctx()` | **Forced** to that tenant. A caller-supplied `tenantId` is overridden, so forwarding client input can never widen the scope. |
| No context tenant, explicit `trail({ tenantId })` | Honoured — a system job or CLI pinning one tenant deliberately. |
| No context tenant, no `tenantId`, **no `tenancyPlugin`** | Returns the trail. A single-tenant app has no tenant dimension, so there is nothing to cross. |
| No context tenant, no `tenantId`, **`tenancyPlugin` registered** | **Throws.** Returning every tenant's records must be deliberate — use `systemTrail()`. |

`systemTrail(query)` is the **system-only** escape hatch: it reads across all
tenants, bypassing the auto-scoping above. Use it from trusted platform/admin
tooling only, and never pass client-controlled input into it — that re-opens
exactly the cross-tenant exposure `trail()` closes.

```ts
// Single-tenant app (no tenancyPlugin): this is the normal read.
await audit.trail()

// Multi-tenant app: scoped automatically inside a request…
await audit.trail()                    // → only ctx().tenant's entries
// …and a platform-wide read is spelled out.
await audit.systemTrail({ event: 'billing:**' })
```

Event patterns support segments separated by `:` (hooks) or `.` (events): `*` matches one segment, `**` matches one or more. E.g.: `auth:*` matches `auth:login`; `order.**` matches `order.created` and `order.item.added`; `**` matches everything.

### Verifiable trail (hash chain)

"Append-only" in the store interface is a promise the code keeps; it does not stop someone with database access from editing a row. Turn on `integrity: 'hash-chain'` to make the trail **tamper-evident**:

```ts
auditPlugin({ store: sqliteAuditStore('./data/audit.db').store, integrity: 'hash-chain' })
```

Every entry then carries `seq` (its position in the chain, from 1), `prevHash` (the previous entry's hash) and `hash` = SHA-256 over `prevHash` + a canonical serialization of the entry (stable key order, explicit fields: `id`, `seq`, `tenantId`, `at`, `source`, `event`, `actorId`, `requestId`, `ip`, `userAgent` and the payload as persisted). There is **one chain per tenant**, plus one for entries recorded without a tenant (the system chain), so tenants never contend with each other and each can be verified alone.

```ts
const result = await audit.verify({ tenantId: 'acme' })        // or { from: 100, to: 200 }
// { ok: true, tenantId: 'acme', checked: 1284, unchained: 0, head: { seq: 1284, hash: '…' } }
// { ok: false, …, firstBrokenAt: 17, entryId: '…', reason: 'hash-mismatch' }

const all = await audit.verifyAll()   // system-only: every chain → { ok, chains: [...] }
```

`verify` recomputes each hash and checks the `seq` continuity and the `prevHash` links, so it detects an **edited** row (`hash-mismatch`), a **deleted** row (`sequence-gap`), **reordered** rows and a **forged** row that does not link (`prev-hash-mismatch`, `sequence-duplicate`). `from`/`to` are sequence numbers (inclusive); a window is anchored on the entry at `from - 1` (`missing-predecessor` if it is gone). Tenant scoping works like `trail()`: inside a tenant context the context tenant is forced; outside one, `tenantId` picks the chain and omitting it verifies the system chain.

Rows written **before** integrity was enabled have no hash: `verify` counts them as `unchained` — they are never reported as broken.

**Concurrency.** Appends to one chain are serialized in-process (a per-chain mutex). Across replicas, the store is the guarantee: the SQLite and Prisma stores have a unique `(chain, seq)` constraint, so two replicas racing for the same `seq` cannot fork the chain — the loser gets `AuditChainConflictError`, re-reads the head and retries (with jittered backoff, up to 10 attempts). A custom store that implements the chain methods must do the same.

**What a hash chain does and does not prove.** A plain SHA-256 chain can be recomputed by anyone who can write to the database — it catches accidental and naive tampering, not a determined DBA who rewrites every hash after the edit. Two mitigations, both cheap:

- **Key the chain**: `integrity: { mode: 'hash-chain', key: process.env.AUDIT_CHAIN_KEY! }` makes every hash an HMAC-SHA256 (key of at least 128 bits, stored outside the database). Without the key a writer cannot produce a chain that verifies.
- **Anchor the head**: `verify()` returns `head: { seq, hash }`. Record it periodically somewhere the database role cannot reach (a log sink, object storage with retention lock). Truncating the tail of a chain leaves no gap, so it is only detectable by comparing against an anchor.

**Harden the table.** Make the database enforce append-only too — the application role should only be able to insert and read. On PostgreSQL:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM app_role;
GRANT SELECT, INSERT ON audit_entries TO app_role;
```

(Run migrations with a separate owner role.) SQLite has no roles: protect the file with filesystem permissions and back it up.

#### `basalt audit:verify`

With `integrity` on, the plugin registers an `audit:verify` command in the CLI's `commands` bucket — no extra wiring:

```bash
basalt audit:verify                  # the system chain
basalt audit:verify --tenant=acme    # one tenant
basalt audit:verify --tenant=acme --from=100 --to=200
basalt audit:verify --all            # every chain; exits 1 if any is broken
```

Outside the plugin, `createAuditVerifyCommand(() => audit)` returns the same command definition — register it with `cliPlugin([...])` or call its `handle` from a scheduled job.

### Request context (IP / user-agent)

Opt in to recording the client IP and user-agent of the originating request:

```ts
auditPlugin({ requestContext: true })
```

The plugin registers an HTTP enricher (in the neutral `http:enrichers` bucket, so it works on **fastify, express and hono**) that puts `{ ip, userAgent }` in `ctx().client`; every entry recorded inside that request — manual, hook or event — gets `ip` and `userAgent` (the user-agent is truncated to 512 characters). Outside a request (jobs, CLI) the fields are absent. The IP is whatever the adapter reports as `request.ip`: configure your adapter's trusted-proxy setting so it is the client's address, not the load balancer's.

To take them from elsewhere, pass a resolver instead: `requestContext: (context) => ({ ip: context?.forwardedIp, userAgent: … })`.

**An IP address is personal data.** It is off by default. The request fields go through the configured redactor as `{ ip, userAgent }` before they are stored, so with `createPiiMinimizingRedactor({ key })` the IP is stored as a `pii_<hmac>` pseudonym (still correlatable, not reversible without the key); a redactor that drops them wins. Include `ip`/`userAgent` in your retention and data-subject-request policies.

### Custom store (production)

`MemoryAuditStore` loses everything when the process ends. In production, implement `AuditStore` over your database — the contract is append-only (no update or delete):

```ts
import type { AuditEntry, AuditQuery, AuditStore } from '@basaltkit/audit'
import { auditPlugin } from '@basaltkit/audit'

// Hash-chain support (optional): also implement chainHead, readChain,
// countUnchained and chainTenants, and reject a duplicate (chain, seq) with
// AuditChainConflictError — see "interface AuditStore" below.
class SqlAuditStore implements AuditStore {
  async append(entry: AuditEntry): Promise<void> {
    // INSERT into the audit_entries table…
  }
  async query(query: AuditQuery): Promise<AuditEntry[]> {
    // SELECT with filters, ORDER BY at DESC, LIMIT…
    return []
  }
}

auditPlugin({ store: new SqlAuditStore() })
```

## API reference

### `auditPlugin(options?: AuditPluginOptions)`

Registers an `Audit` (singleton, token `AUDIT`), hooks into **all** hooks (`hooks.onAny`) filtering by the patterns, and on `boot` subscribes to the `EventBus` (if present in the container) to record events.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `store` | `AuditStore` | No | `new MemoryAuditStore()` | Where entries are stored. |
| `hooks` | `string[]` | No | `['auth:**', 'billing:**', 'tenancy:created', 'permission:**']` | Hook patterns recorded automatically (replaces the defaults). |
| `events` | `string[]` | No | `['**']` (everything) | EventBus event patterns recorded. `[]` disables it. |
| `redact` | `AuditRedactor` | No | `defaultAuditRedactor` | Scrubs each payload (and the request fields) before it is stored. See "Redaction". |
| `onCaptureError` | `(error, { source, event }) => void` | No | logs | Called when a bridged hook/event capture fails; the emitting operation continues. |
| `integrity` | `'none' \| 'hash-chain' \| { mode: 'hash-chain', key? }` | No | `'none'` | Hash-chains every entry per tenant so `verify()` detects tampering, and registers `audit:verify`. With `key` (>= 128 bits) the hash is HMAC-SHA256. Needs a store with the chain methods. See "Verifiable trail". |
| `requestContext` | `boolean \| (ctx) => { ip?, userAgent? }` | No | off | Records the client `ip` / `userAgent`. `true` registers an HTTP enricher (all adapters) filling `ctx().client`. IP is PII — see "Request context". |

### `class Audit`

| Method | Signature | Description |
|---|---|---|
| `constructor` | `new Audit(store, redact?, tenancyActive?, options?: AuditOptions)` | Creates the facade over a store. `options` takes `integrity` and `requestContext` (as in the plugin). |
| `record` | `(event: string, payload?: unknown) => Promise<AuditEntry>` | Manual entry (`source: 'manual'`), enriched from context. Returns the entry (with `seq`/`hash` when chained). |
| `trail` | `(query?: AuditQuery) => Promise<AuditEntry[]>` | Query, most recent first, tenant-scoped (see above). |
| `systemTrail` | `(query?: AuditQuery) => Promise<AuditEntry[]>` | System-only cross-tenant read. |
| `verify` | `(options?: { tenantId?, from?, to? }) => Promise<AuditVerifyResult>` | Verifies one hash chain: `{ ok, tenantId, checked, unchained, firstBrokenAt?, entryId?, reason?, head? }`. Tenant-scoped like `trail()`. |
| `verifyAll` | `() => Promise<{ ok, chains: AuditVerifyResult[] }>` | System-only: verifies every chain (system chain first). |
| `capture` | `(source: 'hook' \| 'event', event, payload) => Promise<void>` | **Advanced/internal**: used by the plugin's listeners. |

### `interface AuditEntry` (all fields `readonly`)

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID generated at record time. |
| `source` | `'hook' \| 'event' \| 'manual'` | Origin of the entry. |
| `event` | `string` | Name of the hook/event/action. |
| `payload` | `unknown` | Associated data. |
| `actorId` | `string \| undefined` | `ctx().user.id` at record time. |
| `tenantId` | `string \| undefined` | `ctx().tenant.id` at record time. |
| `requestId` | `string \| undefined` | `ctx().requestId`. |
| `ip` | `string \| undefined` | Client IP (or its pseudonym) — only with `requestContext`. |
| `userAgent` | `string \| undefined` | Client user-agent (max 512 chars) — only with `requestContext`. |
| `at` | `number` | Timestamp (`Date.now()`, milliseconds). |
| `seq` | `number \| undefined` | Position in the tenant's chain (from 1) — only with `integrity`. |
| `prevHash` | `string \| undefined` | Previous entry's `hash` (`AUDIT_CHAIN_GENESIS` for the first). |
| `hash` | `string \| undefined` | SHA-256 / HMAC-SHA256 hex over `prevHash` + `canonicalAuditEntry(entry)`. |

### `interface AuditQuery`

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `event` | `string` | No | all | Wildcard pattern over the name (e.g. `'auth:**'`). |
| `tenantId` | `string` | No | all | Filters by tenant. |
| `actorId` | `string` | No | all | Filters by actor. |
| `since` | `number` | No | since forever | Only entries with `at >= since`. |
| `limit` | `number` | No | no limit | Maximum number of results. Must be a non-negative safe integer — `trail()`, `systemTrail()` and the bundled stores throw a `TypeError` otherwise (`assertAuditLimit`), so coerce and validate a query-string value before forwarding it. The SQL-backed stores push it into the database as a bound parameter, so a limited query never loads the whole trail. |

### `interface AuditStore`

Storage contract, **append-only by contract** (no update/delete):

- `append(entry: AuditEntry): Promise<void>`
- `query(query: AuditQuery): Promise<AuditEntry[]>` — must return most recent first and apply filters/limit.

Optional, required for `integrity: 'hash-chain'` (implemented by `MemoryAuditStore`, `@basaltkit/audit-sqlite` and `@basaltkit/audit-prisma`):

- `chainHead(tenantId): Promise<{ seq, hash } | undefined>` — latest entry of the chain (`undefined` tenant = system chain).
- `readChain(tenantId, { fromSeq, toSeq?, limit }): Promise<AuditEntry[]>` — chained entries in ascending `seq`.
- `countUnchained(tenantId): Promise<number>` — rows of that tenant without a chain (written before integrity).
- `chainTenants(): Promise<Array<string | undefined>>` — tenants that have a chain.
- `append` must reject an entry whose `(auditChainKey(tenantId), seq)` already exists with `AuditChainConflictError` — a unique constraint in SQL. `auditChainKey` maps a tenant to a never-NULL key (`'t:<id>'`, or `'@system'`), because SQL unique indexes treat NULLs as distinct.

Hash-chain helpers are exported for stores and tooling: `computeAuditHash(entry, key?)`, `canonicalAuditEntry(entry)`, `AUDIT_CHAIN_GENESIS`, `auditChainKey` / `parseAuditChainKey`, `AuditChainConflictError` (code `AUDIT_CHAIN_CONFLICT`) and `createAuditVerifyCommand`.

Two helpers exist so a driver can push the limit down safely:

- `exactEventMatch(pattern?: string): string | undefined` — the event filter that may be pushed into SQL as an equality. Returns `undefined` for a pattern containing `*` (a wildcard) **or** `.` (because `patternMatches` treats `.` and `:` as interchangeable, so an equality would miss `a:b` for the pattern `a.b`); those must still be matched in code.
- `AUDIT_SCAN_PAGE: number` — rows a driver should read per round-trip when a wildcard forces a scan (500). Bounds peak memory.

### `class MemoryAuditStore`

In-memory implementation of `AuditStore` (freezes each entry; filters and reverses on query). Ideal for dev and tests; does not persist.

### Redaction

Payloads are scrubbed before they are persisted. `redactSensitive` masks values under secret-looking keys (`password`, `token`, `api_key`, `authorization`, …) as `'[redacted]'`; the opt-in `createPiiMinimizingRedactor({ key })` (or `redactSensitiveAndPii`) additionally replaces email/phone-shaped values, and values under common PII keys, with a `pii_<hmac>` pseudonym: HMAC-SHA256 under your key, truncated to 128 bits.

```ts
auditPlugin({ redact: createPiiMinimizingRedactor({ key: process.env.AUDIT_PII_KEY! }) })
```

IP-address keys (`ip`, `ipAddress`, `clientIp`, `remoteAddr`, `x-forwarded-for`, matched exactly — not `zip` or `recipient`) count as PII too, and so does the entry's own `ip` field when `requestContext` is on.

Every value under a PII key is pseudonymized whatever its shape — a number, a list, or a nested object (each scalar leaf; secret-looking keys inside are still masked). The key must be a string or `Uint8Array` secret of at least 16 bytes (128 bits); keep it out of the audit database. With the key, the same value always maps to the same pseudonym, so entries stay correlatable; without it, a pseudonym cannot be reversed by hashing candidate emails or phone numbers. If no key is configured (`createPiiMinimizingRedactor()` or the `piiMinimizingRedactor` constant), a random per-process key is used and a warning is logged: pseudonyms are still irreversible but no longer correlate across restarts.

Both walk **6 levels deep**. Anything deeper is replaced with `'[truncated]'` — not passed through. Payloads are arbitrary and the default subscription is `events: ['**']`, so returning the raw subtree meant a secret nested seven levels down reached the trail in cleartext. If your payloads are deeply nested, flatten them before recording rather than relying on depth.

### `patternMatches(pattern: string, name: string): boolean`

Wildcard matcher over `:` and `.` segments — exported for reuse. `*` = one segment; `**` = one or more; `'**'` matches everything.

```ts
import { patternMatches } from '@basaltkit/audit'

patternMatches('auth:**', 'auth:login')      // true
patternMatches('order.*', 'order.created')   // true
patternMatches('auth:**', 'billing:paid')    // false
```

### Token

- `AUDIT: Token<Audit>` — `app.container.get(AUDIT)`.

## Common errors and solutions (FAQ)

**Entries come back with empty `actorId`/`tenantId`.**
There was no active context at record time. Make sure the code runs inside `runWithContext({ user, tenant }, …)` — in HTTP, this is established by the middleware.

**Domain events aren't being recorded.**
Either `eventsPlugin()` isn't registered (`auditPlugin` only subscribes to the bus if `container.has(EVENTS)`), or you passed `events: []`, or the patterns don't match the event names.

**One of my hooks doesn't show up in the trail.**
The defaults only cover `auth/billing/tenancy/permission`. Pass `hooks: [...]` with your own patterns — note that the list **replaces** the defaults, so include the ones you want to keep too.

**I lost the history after restarting.**
`MemoryAuditStore` is volatile. In production, implement `AuditStore` over a database.

**A deeply-nested field comes back as `'[truncated]'`.**
The redactors stop at 6 levels and drop everything below, so a secret can never slip past the depth bound. Flatten the payload (or record the interesting fields explicitly) if you need that data in the trail.

**Can I edit or delete an entry?**
No — the contract is append-only and entries are frozen. This is a feature, not a limitation: it's what gives the trail evidentiary value. To make that hold against someone with database access too, enable `integrity: 'hash-chain'`, revoke `UPDATE`/`DELETE` on the table, and run `basalt audit:verify` (see "Verifiable trail").

**`verify()` reports `unchained` rows.**
They were written before `integrity` was enabled and carry no hash. They are not broken — just not verifiable. New entries are chained from `seq` 1.

**`AuditChainConflictError` reached my code.**
Ten attempts in a row lost the race for the next `seq` — very heavy contention on one tenant's chain across replicas. The entry was not written; retry the operation.

**What's the difference between `:` and `.` in names?**
Convention: lifecycle hooks use `:` (`auth:login`); domain events use `.` (`order.created`). `patternMatches` treats both as segment separators.

## How it connects to other modules

- **`@basaltkit/core`** — lifecycle hooks (`hooks.onAny`) are the primary capture source; the ALS context (`tryCtx`) supplies actor/tenant/requestId; the plugin uses `definePlugin`/`createToken`.
- **`@basaltkit/events`** — secondary capture source: any domain event emitted on the `EventBus` can land in the trail (`events` patterns).
- **`@basaltkit/activity`** — sibling module with a different focus: **activity** is the "human-friendly" feed shown to the user ("Maria published the project"); **audit** is the automatic, immutable security/compliance record.
- **`@basaltkit/logger`** — logs are ephemeral technical diagnostics; audit is durable business record. Use both.
- **`@basaltkit/queue`** — since context travels to workers, entries recorded inside a job retain the actor/tenant of the original request.
