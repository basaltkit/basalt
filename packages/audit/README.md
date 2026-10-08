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

Each entry is frozen, payload included (a deep-frozen copy taken after redaction — your own object is never frozen) — code can't tamper with the in-memory history, even by accident. To query, use `audit.trail()` with filters on event (with wildcards), tenant, actor, and date.

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

By default, hooks matching `auth:**`, `billing:**`, `tenancy:created`, or `permission:**` are recorded (not `tenancy:switched`, which fires on every request), except those in `DEFAULT_AUDIT_HOOK_EXCLUDES`: `auth:apikey_rejected`, which any anonymous client can trigger on every request by presenting a dead API key. Refusals of a key that did verify are still recorded, as `auth:apikey_refused`. You can replace the list:

```ts
import { auditPlugin } from '@basaltkit/audit'

auditPlugin({
  hooks: ['auth:**', 'billing:**', 'api-keys:**'], // replaces the defaults (the default excludes still apply)
})

// Object form: a hook is recorded when it matches `include` and not `exclude`.
auditPlugin({ hooks: { include: ['auth:**'], exclude: ['auth:login'] } })
```

A hook named exactly (no wildcard) in `include` is always recorded, which is how you opt `auth:apikey_rejected` back in: `hooks: ['auth:**', 'auth:apikey_rejected']`. `exclude: []` turns the default excludes off.

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

Outside a request (a script, a CLI command) there is no context, so the entry
goes to the system chain with no actor. Wrap the work in `runWithContext` as
above, or pass an explicit scope as the third argument:

```ts
await audit.record('report.generated', { rows }, { tenantId: 'acme', actorId: 'job:nightly' })
```

The scope can only **narrow**: inside a context with a tenant (or a user), a
different `scope.tenantId` (or `scope.actorId`) throws a `TypeError`. Queue jobs
need neither: `@basaltkit/queue` restores the dispatcher's tenant and user.

The `audit:` event prefix is **reserved** for framework events. Today only
`'audit:redacted'` is enforced — `record('audit:redacted', …)` throws a
`TypeError`, because only `audit.redact()` may write it — but do not name your
own events `audit:*`: a later major will reserve the whole prefix.

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
| No context tenant, no `tenantId`, **no `tenancyPlugin`** | Returns the trail. A single-tenant app has no tenant dimension, so there is nothing to cross. A hand-built `new Audit(store)` assumes this too — pass `() => true` as its third argument (`tenancyActive`) in a multi-tenant app. |
| No context tenant, no `tenantId`, **`tenancyPlugin` registered** | **Throws.** Returning every tenant's records must be deliberate — use `systemTrail()`. |

`systemTrail(query)` is the **system-only** escape hatch: it reads across all
tenants, bypassing the auto-scoping above. Use it from trusted platform/admin
tooling only, and never pass client-controlled input into it — that re-opens
exactly the cross-tenant exposure `trail()` closes.

Every filter is type-checked before any store sees it (`assertAuditQuery`):
`event`, `tenantId` and `actorId` must be strings, `since` a finite number,
`limit` a non-negative safe integer. A query-string parser such as `qs` turns
`?tenantId[not]=x` into `{ not: 'x' }`, which an ORM would read as an operator
("every tenant but x"); `trail()`, `systemTrail()` and the bundled stores throw a
`TypeError` instead.

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

Every entry then carries `seq` (its position in the chain, from 1), `prevHash` (the previous entry's hash) and `hash` = SHA-256 (or HMAC-SHA256 under a key) over `prevHash` + a canonical serialization of the entry (stable key order, explicit fields: `v`, `alg`, `kid`, `id`, `seq`, `tenantId`, `at`, `source`, `event`, `actorId`, `requestId`, `ip`, `userAgent` and the payload as persisted). The stored hash is self-describing — `v2:sha256:<hex>` or `v2:hmac-sha256:<keyId>:<hex>` — and the algorithm and key id are part of what is digested, so an entry cannot be relabelled to another key. There is **one chain per tenant**, plus one for entries recorded without a tenant (the system chain), so tenants never contend with each other and each can be verified alone.

```ts
const result = await audit.verify({ tenantId: 'acme' })        // or { from: 100, to: 200 }
// { ok: true, tenantId: 'acme', checked: 1284, unchained: 0, head: { seq: 1284, hash: '…' } }
// { ok: false, …, firstBrokenAt: 17, entryId: '…', reason: 'hash-mismatch' }

const all = await audit.verifyAll()   // system-only: every chain → { ok, chains: [...] }
```

`verify` recomputes each hash and checks the `seq` continuity and the `prevHash` links, so it detects an **edited** row (`hash-mismatch`), a **deleted** row (`sequence-gap`), **reordered** rows and a **forged** row that does not link (`prev-hash-mismatch`, `sequence-duplicate`). A second row at one `seq` is a `sequence-duplicate` wherever it falls: `verify` reads the chain in pages of `AUDIT_SCAN_PAGE` (500) and each page re-reads the last entry of the previous one, so a duplicate at a page boundary — possible in a custom store without the `(chain, seq)` unique index — is not skipped. `from`/`to` are sequence numbers (inclusive); a window is anchored on the entry at `from - 1` (`missing-predecessor` if it is gone). Tenant scoping works like `trail()`: inside a tenant context the context tenant is forced; outside one, `tenantId` picks the chain and omitting it verifies the system chain.

**Rows outside the chain.** `trail()` serves every row of the table, so `verify` checks the rows that are *not* in the chain too — a row inserted straight into the database (by someone without the HMAC key) would otherwise read as history while `verify` stayed green:

- Rows written **before** the chain began have no hash and are **legacy**: counted in `unchained`, never reported as broken. "Before" means `at` no later than the chain's first entry — once a tenant's chain exists, `Audit` never writes an unchained row for it again.
- Any other row of the tenant outside its chain — a seq-less row written after the chain began, or a row with a `seq` but a missing (`chain IS NULL`) or foreign chain name — is listed in `unverified` (ids, at most 100) and the result is `ok: false` with `reason: 'unchained-entry'`.
- `legacyUntil` moves the cut-off: `verify({ legacyUntil: 0 })` accepts no legacy row at all — use it when the trail was chained from day one (a writer who backdates `at` can otherwise still pass as legacy), or pass the timestamp you switched integrity on (e.g. after a rolling deploy in which old replicas kept writing unchained rows for a while).
- `trail({ chainedOnly: true })` reads only rows that belong to their tenant's chain — the read to use for evidence. It does not prove them intact; `verify` does.

**Anchoring.** Deleting the tail of a chain leaves no gap. Record `head` somewhere the database role cannot reach and pass it back: `verify({ expectedHead: { seq, hash } })` fails with `'truncated'` when that entry is gone and `'head-mismatch'` when its hash differs. `verifyAll({ expectedHeads: { '@system': …, 't:acme': … } })` does the same per chain (keys are `auditChainKey(tenantId)`) — including a chain deleted wholesale, which would otherwise just be missing from the list.

`verifyAll` is system-only, but inside a tenant context it is scoped like `verify`: it verifies and reports that tenant's chain only. A chain name the store lists that maps to no tenant chain (a forged `chain` value) is reported as `'unknown-chain'`.

`verifyAll` also visits tenants that have rows but **no chain at all** — otherwise a row forged under a tenant that never had a chain would go unchecked. For such a tenant the legacy cut-off defaults to the moment integrity began for the whole store (the earliest first entry of any chain): once `Audit` chains, it never writes an unchained row for any tenant again, so a later one is reported as `'unchained-entry'`. An explicit `legacyUntil` applies to these tenants too. The tenant list comes from the store's optional `auditTenants()`; a store without it is scanned through `query({})`.

**Concurrency.** Appends to one chain are serialized in-process (a per-chain mutex). Across replicas, the store is the guarantee: the SQLite and Prisma stores have a unique `(chain, seq)` constraint, so two replicas racing for the same `seq` cannot fork the chain — the loser gets `AuditChainConflictError`, re-reads the head and retries (with jittered backoff, up to 10 attempts). A custom store that implements the chain methods must do the same.

**What a hash chain does and does not prove.** A plain SHA-256 chain can be recomputed by anyone who can write to the database — it catches accidental and naive tampering, not a determined DBA who rewrites every hash after the edit. Two mitigations, both cheap:

- **Key the chain**: `integrity: { mode: 'hash-chain', key: process.env.AUDIT_CHAIN_KEY! }` makes every hash an HMAC-SHA256 (key of at least 128 bits, stored outside the database). Without the key a writer cannot produce a chain that verifies. A keyed verifier refuses unkeyed (`v2:sha256`) entries, so a writer without the key cannot extend the chain with plain SHA-256 either.
- **Anchor the head**: `verify()` returns `head: { seq, hash }`. Record it periodically somewhere the database role cannot reach (a log sink, object storage with retention lock). Truncating the tail of a chain leaves no gap, so it is only detectable by comparing against an anchor.

**Rotating the key.** Every keyed entry records the id of the key that signed it (`keyId`; default `auditKeyId(key)`, a fingerprint derived from the key, identical on every replica). To rotate, sign with the new key and keep the old one for verification only:

```ts
integrity: {
  mode: 'hash-chain',
  key: process.env.AUDIT_CHAIN_KEY!, keyId: '2026-09',
  verifyKeys: [{ id: '2026-01', key: process.env.AUDIT_CHAIN_KEY_2026_01! }],
  // a bare key works too, under its default id: verifyKeys: [oldKey]
}
```

`verify` picks each entry's key by its id; an entry whose key id is not held fails with `'unknown-key'` (add the retired key to `verifyKeys`). Keep a retired key for as long as you keep the entries it signed. Two different keys under one id, a key id outside `AUDIT_KEY_ID_PATTERN` (1–64 of `A-Z a-z 0-9 . _ -`), and `keyId`/`verifyKeys` without a `key` are refused when the `Audit` is built.

**Legacy hashes.** Entries written before hashes carried a key id hold a bare 64-hex hash (v1). They keep verifying: an unkeyed verifier recomputes the SHA-256, a keyed one accepts the HMAC under **any** key it holds (`key` or `verifyKeys`) — v1 never said which. New entries link onto them as usual. A chain that started unkeyed and later gained a key can be verified in two windows: the unkeyed prefix with an unkeyed `Audit` (`to: n`), the keyed tail with the keyed one (`from: n + 1`).

**Redacted entries.** An entry erased with [`audit.redact()`](#erasing-personal-data-auditredact) keeps its original `hash` — it still carries the chain links — but its content no longer matches it. `verify` checks such an entry through its `audit:redacted` attestation instead: the attestation must exist in the same chain after the entry, be a `manual` entry that verifies (keyed, on a keyed chain), name the entry's `id`, `seq` and `hash`, declare the same erased fields as the entry's `redaction` marker, and record the digest of the entry's current state (`auditRedactionState`); every erased field must hold `'[erased]'`. The walk also checks each `audit:redacted` attestation the other way: its entry must still carry a marker naming that attestation or a later one for the same entry — so a row restored to its original content (which matches its original hash again) or rolled back to an older redaction is caught. Anything else is `'redaction-mismatch'` (with a `detail`). Redacted entries count in `checked` and in `redacted`. Every other entry is verified exactly as before.

**v3 hashes (`erasable`).** After an erasure a v1/v2 hash can still confirm a *guess* of the erased value to whoever can compute it — anyone on a plain SHA-256 chain, the key holder on a keyed one. `integrity: { mode: 'hash-chain', key, erasable: true }` writes v3 entries instead (`v3:sha256:<hex>` / `v3:hmac-sha256:<keyId>:<hex>`): the v2 canonical form plus a random 256-bit `nonce`, which a redaction destroys, so nobody can recompute the hash any more. Off by default (entries stay v2, byte for byte). It needs a store that persists `nonce` — `Audit` reads its first v3 entry back and throws if the nonce was dropped — and every verifier must be upgraded first: an older `@basaltkit/audit` reports v3 entries as `hash-mismatch`. Chains may mix v1, v2 and v3 entries.

**Harden the table.** Make the database enforce append-only too — the application role should only be able to insert and read. On PostgreSQL:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM app_role;
GRANT SELECT, INSERT ON audit_entries TO app_role;
```

(Run migrations with a separate owner role.) Keep this even if you erase personal data: erasure runs through a **dedicated eraser role** that may update only the erasable columns — see [the eraser role](https://github.com/basaltkit/basalt/tree/main/packages/audit-prisma#the-eraser-role) in `@basaltkit/audit-prisma`. SQLite has no roles: protect the file with filesystem permissions and back it up (the `@basaltkit/audit-sqlite` README has optional guard triggers against buggy updates).

#### `basalt audit:verify`

With `integrity` on, the plugin registers an `audit:verify` command in the CLI's `commands` bucket — no extra wiring:

```bash
basalt audit:verify                  # the system chain
basalt audit:verify --tenant=acme    # one tenant
basalt audit:verify --tenant=acme --from=100 --to=200
basalt audit:verify --all            # every chain; exits 1 if any is broken
basalt audit:verify --tenant=acme --expected-head=1284:<hash>   # against an anchor (the head a previous run printed)
basalt audit:verify --all --legacy-until=0                     # no legacy rows accepted
```

`--all` is a boolean flag: `--all`, `--all=true|1|yes` verify every chain, `--all=false|0|no` a single one, and any other value is an error (earlier versions read `--all=true` as "not all" and exited 0 after checking only the system chain). `--all` cannot be combined with `--tenant`, `--from`, `--to` or `--expected-head`, and `--tenant` without a value is an error rather than the system chain.

Outside the plugin, `createAuditVerifyCommand(() => audit)` returns the same command definition — register it with `cliPlugin([...])` or call its `handle` from a scheduled job.

### Request context (IP / user-agent)

Opt in to recording the client IP and user-agent of the originating request:

```ts
auditPlugin({ requestContext: true })
```

The plugin registers an HTTP enricher (in the neutral `http:enrichers` bucket, so it works on **fastify, express and hono**) that puts `{ ip, userAgent }` in `ctx().client`; every entry recorded inside that request — manual, hook or event — gets `ip` and `userAgent` (the user-agent is truncated to 512 characters). Outside a request (jobs, CLI) the fields are absent. The IP is whatever the adapter reports as `request.ip`: configure your adapter's trusted-proxy setting so it is the client's address, not the load balancer's.

To take them from elsewhere, pass a resolver instead: `requestContext: (context) => ({ ip: context?.forwardedIp, userAgent: … })`.

**An IP address is personal data.** It is off by default. The request fields go through the configured redactor as `{ ip, userAgent }` before they are stored, so with `createPiiMinimizingRedactor({ key })` the IP is stored as a `pii_<hmac>` pseudonym (still correlatable, not reversible without the key); a redactor that drops them wins. Include `ip`/`userAgent` in your retention and data-subject-request policies.

### Erasing personal data (`audit.redact`)

Prefer [`fieldPolicies`](#personal-data-per-event): a value that is never stored
needs no erasure. For what is already stored — a data-subject request, a field
that should never have been recorded — `audit.redact()` erases chosen fields of
one entry **in place** and keeps the trail verifiable:

```ts
const { entry, attestation, changed, residual } = await audit.redact(entryId, {
  payload: ['customer.email', 'items[].note'], // fieldPolicies paths, or 'all'
  ip: true,                                     // and/or userAgent: true
  reasonRef: 'DSR-2026-114',                    // opaque, non-personal reference
})
```

- Each value a path reaches becomes `'[erased]'` (`AUDIT_ERASED`); `ip` /
  `userAgent` are dropped. Absent paths are skipped, and a request that changes
  nothing writes nothing (`changed: false`). Erasing again merges into the same
  cumulative `redaction` marker on the entry.
- In the same transaction an **attestation** is appended to the entry's own
  chain: an `audit:redacted` entry (source `manual`, actor = the eraser) whose
  payload binds the entry's `id`, `seq` and original `hash`, the erased fields,
  a digest of the entry's new state and `reasonRef` — never the erased data.
  `verify()` checks the redacted entry through it (see "Redacted entries" above).
- **Scope** mirrors `trail()`: inside a tenant context only that tenant's
  entries are reachable (any other id is `AuditEntryNotFoundError`, 404 — no
  existence oracle); without one, `tenantId` in the request pins the tenant; with
  neither, a multi-tenant app must call `audit.systemRedact()`, the deliberate
  cross-tenant path for trusted tooling. `actorId` names the eraser outside a
  request (it must equal the context user inside one).
- **Refused** (`AuditRedactionRefusedError`, nothing written) with a `reason`:
  `'unverified'` — the entry does not verify as it is now (so a redaction never
  launders tampered content), it is an attestation, or it is chained but this
  `Audit` has no integrity; `'residual'` — see below; `'unsupported-store'` — the
  store lacks `get()` / `redact()`.
- Concurrent redactions of one entry (other replicas too) are safe: the store
  only applies one whose base is still current (`AuditRedactionConflictError`
  otherwise), and `Audit` re-reads and merges.

**Residual.** After erasure the entry's old hash may still let someone confirm a
guess of the erased value:

| Entry hash | `residual` | Who can confirm a guess |
|---|---|---|
| none (unchained), v3 | `'none'` | nobody |
| v2 HMAC, v1 under a keyed verifier | `'keyed'` | the integrity-key holder |
| v2 SHA-256, unkeyed v1 | `'public'` | anyone who reads the row |

`request.residual` is the most you accept, default `'keyed'`: erasing from a
plain SHA-256 chain must be acknowledged with `residual: 'public'`. Turn on
`erasable` (above) so entries written from now on have no residual.

**What is not erased.** Opaque ids (`actorId`, `tenantId`, `requestId`), the
event name and the time stay — erase the user in your auth store and `actorId`
no longer identifies anyone. Copies elsewhere are yours to erase: the events
outbox, activity feeds, search indexes, logs and **backups** (keep the
data-subject-request ledger outside the database and re-apply it after a
restore). Who may erase is the app's decision: wrap the call in an authorized
job or command — there is deliberately no HTTP route, CLI command or MCP tool.

### Custom store (production)

`MemoryAuditStore` loses everything when the process ends. In production, implement `AuditStore` over your database — the contract is append-only (no delete, and no update but the attested erasure, `redact()`):

```ts
import type { AuditEntry, AuditQuery, AuditStore } from '@basaltkit/audit'
import { auditPlugin } from '@basaltkit/audit'

// Hash-chain support (optional): also implement chainHead, readChain,
// countUnchained and chainTenants (and ideally readUnchained), and reject a
// duplicate (chain, seq) with AuditChainConflictError — see "interface AuditStore" below.
// Erasure support (optional): implement get() and redact(), and round-trip the
// `nonce` and `redaction` fields.
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
| `hooks` | `string[] \| { include: string[]; exclude?: string[] }` | No | `['auth:**', 'billing:**', 'tenancy:created', 'permission:**']`, minus `DEFAULT_AUDIT_HOOK_EXCLUDES` | Hook patterns recorded automatically (replaces the defaults). `exclude` defaults to `DEFAULT_AUDIT_HOOK_EXCLUDES`; a hook named exactly in `include` is always recorded. |
| `events` | `string[]` | No | `['**']` (everything) | EventBus event patterns recorded. `[]` disables it. |
| `redact` | `AuditRedactor` | No | `defaultAuditRedactor` | Scrubs each payload (and the request fields) before it is stored. See "Redaction". |
| `onCaptureError` | `(error, { source, event }) => void` | No | logs | Called when a bridged hook/event capture fails; the emitting operation continues. |
| `integrity` | `'none' \| 'hash-chain' \| { mode: 'hash-chain', key?, keyId?, verifyKeys?, erasable? }` | No | `'none'` | Hash-chains every entry per tenant so `verify()` detects tampering, and registers `audit:verify`. With `key` (>= 128 bits) the hash is HMAC-SHA256 and records `keyId` (default `auditKeyId(key)`); `verifyKeys` holds retired keys (bare, or `{ id, key }`) so a rotation keeps history verifiable. `erasable: true` writes v3 (nonce) entries. Needs a store with the chain methods. See "Verifiable trail". |
| `requestContext` | `boolean \| (ctx) => { ip?, userAgent? }` | No | off | Records the client `ip` / `userAgent`. `true` registers an HTTP enricher (all adapters) filling `ctx().client`. IP is PII — see "Request context". |
| `fieldPolicies` | `Record<string, { omit?: string[]; pseudonymize?: string[] }>` | No | none | Per-event personal-data policy, keyed by exact event/hook name, applied before the redactor and before hashing. See "Personal data per event". |
| `fieldPolicyKey` | `string \| Uint8Array` | No | random per process | Keys the `pseudonymize` pseudonyms (>= 128 bits). |

### `class Audit`

| Method | Signature | Description |
|---|---|---|
| `constructor` | `new Audit(store, redact?, tenancyActive?, options?: AuditOptions)` | Creates the facade over a store. `options` takes `integrity`, `requestContext`, `fieldPolicies` and `fieldPolicyKey` (as in the plugin). |
| `record` | `(event: string, payload?: unknown, scope?: { tenantId?, actorId? }) => Promise<AuditEntry>` | Manual entry (`source: 'manual'`), enriched from context. `scope` attributes an entry recorded outside a request and can only narrow (a value differing from the context throws). Returns the entry (with `seq`/`hash` when chained). |
| `trail` | `(query?: AuditQuery) => Promise<AuditEntry[]>` | Query, most recent first, tenant-scoped (see above). |
| `systemTrail` | `(query?: AuditQuery) => Promise<AuditEntry[]>` | System-only cross-tenant read. |
| `verify` | `(options?: { tenantId?, from?, to?, expectedHead?, legacyUntil? }) => Promise<AuditVerifyResult>` | Verifies one hash chain and the tenant's rows outside it: `{ ok, tenantId, checked, redacted, unchained, unverified, firstBrokenAt?, entryId?, reason?, detail?, head? }`. `reason` is one of `hash-mismatch`, `prev-hash-mismatch`, `sequence-gap`, `sequence-duplicate`, `missing-predecessor`, `unchained-entry`, `truncated`, `head-mismatch`, `unknown-key`, `redaction-mismatch`. Tenant-scoped like `trail()`. |
| `verifyAll` | `(options?: { expectedHeads?, legacyUntil? }) => Promise<{ ok, chains: AuditVerifyResult[] }>` | System-only: verifies every chain (system chain first); a forged chain name fails with `unknown-chain`. Inside a tenant context, only that tenant's chain. |
| `redact` | `(entryId: string, request: AuditRedactRequest) => Promise<AuditRedactResult>` | Erases payload paths / `ip` / `userAgent` of one entry, keeping the chain verifiable through an `audit:redacted` attestation. Tenant-scoped like `trail()`. See "Erasing personal data". |
| `systemRedact` | `(entryId: string, request: AuditRedactRequest) => Promise<AuditRedactResult>` | System-only cross-tenant `redact` (`request.tenantId` still pins). |
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
| `hash` | `string \| undefined` | `v2:sha256:<hex>` or `v2:hmac-sha256:<keyId>:<hex>` over `prevHash` + `canonicalAuditEntry(entry, { alg, keyId })` (see `computeAuditHashV2`); `v3:…` with `erasable` (`computeAuditHashV3`); a bare 64-hex (v1) hash on entries written by earlier releases. Up to 144 characters. A redacted entry keeps its original hash. |
| `nonce` | `string \| undefined` | v3 entries only: the random secret inside the hash, cleared by a redaction. |
| `redaction` | `{ attestationId, payload: string[] \| 'all', ip, userAgent } \| undefined` | Present once the entry was erased with `redact()`: what was erased and which `audit:redacted` entry vouches for it. |

### `interface AuditQuery`

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `event` | `string` | No | all | Wildcard pattern over the name (e.g. `'auth:**'`). |
| `tenantId` | `string` | No | all | Filters by tenant. |
| `actorId` | `string` | No | all | Filters by actor. |
| `since` | `number` | No | since forever | Only entries with `at >= since`. |
| `limit` | `number` | No | no limit | Maximum number of results. Must be a non-negative safe integer — `trail()`, `systemTrail()` and the bundled stores throw a `TypeError` otherwise (`assertAuditLimit`), so coerce and validate a query-string value before forwarding it. The SQL-backed stores push it into the database as a bound parameter, so a limited query never loads the whole trail. |
| `chainedOnly` | `boolean` | No | `false` | Only rows in their tenant's hash chain (excludes legacy rows and rows written behind `Audit`'s back). |

`event`, `tenantId` and `actorId` must be strings and `since` a finite number: `assertAuditQuery(query)` (used by `trail()`, `systemTrail()` and the bundled stores) throws a `TypeError` for anything else — an operator object such as `{ not: 'x' }` never reaches a driver.

### `interface AuditStore`

Storage contract, **append-only by contract** (no delete; no update but `redact()`):

- `append(entry: AuditEntry): Promise<void>`
- `query(query: AuditQuery): Promise<AuditEntry[]>` — must return most recent first and apply filters/limit.

Optional, required for `integrity: 'hash-chain'` (implemented by `MemoryAuditStore`, `@basaltkit/audit-sqlite` and `@basaltkit/audit-prisma`):

- `chainHead(tenantId): Promise<{ seq, hash } | undefined>` — latest entry of the chain (`undefined` tenant = system chain).
- `readChain(tenantId, { fromSeq, toSeq?, limit }): Promise<AuditEntry[]>` — chained entries in ascending `seq`.
- `countUnchained(tenantId): Promise<number>` — rows of that tenant without a chain (written before integrity).
- `chainTenants(): Promise<Array<string | undefined>>` — tenants that have a chain.
- `auditTenants?(): Promise<Array<string | undefined>>` — optional: every tenant with at least one row, chained or not (`SELECT DISTINCT tenant_id`). `verifyAll` uses it to reach tenants without a chain; without it, it scans `query({})`, which reads the whole trail.
- `readUnchained?(tenantId, { since, limit }): Promise<AuditEntry[]>` — optional: the tenant's rows outside its chain with `at >= since`, plus any that carries a `seq` or chain name whatever its `at`, oldest first. Without it `verify` scans `query()` for seq-less rows instead.
- `append` must reject an entry whose `(auditChainKey(tenantId), seq)` already exists with `AuditChainConflictError` — a unique constraint in SQL. `auditChainKey` maps a tenant to a never-NULL key (`'t:<id>'`, or `'@system'`), because SQL unique indexes treat NULLs as distinct.

Optional, required for `redact()` (and by `verify()` once a redacted entry exists):

- `get(id): Promise<AuditEntry | undefined>` — one entry by id, any chain.
- `redact(write: AuditRedactionWrite): Promise<void>` — the only sanctioned in-place change, **atomic**: set `payload`, `ip`, `userAgent` and `redaction` (persist `redaction.attestationId` as a `redactedBy` column) and clear `nonce`, only while the row's `hash` and `redactedBy` still equal `write.expect` (else `AuditRedactionConflictError`), and append `write.attestation` in the same transaction with `append()`'s `(chain, seq)` semantics. On any error nothing is written.
- A store must round-trip `nonce` and `redaction`: one that drops them turns v3 or redacted entries into `hash-mismatch`. A store without `get()` that holds a redacted entry fails `verify()` closed (`redaction-mismatch`, `detail` names the method).

Hash-chain helpers are exported for stores and tooling: `computeAuditHashV2(entry, { id, key }?)` (what `Audit` writes), `computeAuditHashV3(entry, { id, key }?)` (with `erasable`), `computeAuditHash(entry, key?)` (the legacy v1 hash), `auditRedactionState(entry)`, `auditStableJson(value)`, `AUDIT_ERASED`, `AUDIT_REDACTED_EVENT`, `AuditRedactionConflictError` (`AUDIT_REDACTION_CONFLICT`), `AuditEntryNotFoundError` (`AUDIT_ENTRY_NOT_FOUND`, 404), `AuditRedactionRefusedError` (`AUDIT_REDACTION_REFUSED`, with `reason`), `checkAuditHash(entry, keysById)`, `parseAuditHash(hash)` / `isAuditHash(value)`, `auditKeyId(key)`, `AUDIT_KEY_ID_PATTERN`, `canonicalAuditEntry(entry, scheme?)`, `AUDIT_CHAIN_GENESIS`, `auditChainKey` / `parseAuditChainKey`, `AuditChainConflictError` (code `AUDIT_CHAIN_CONFLICT`) and `createAuditVerifyCommand`.

Two helpers exist so a driver can push the limit down safely:

- `exactEventMatch(pattern?: string): string | undefined` — the event filter that may be pushed into SQL as an equality. Returns `undefined` for a pattern containing `*` (a wildcard) **or** `.` (because `patternMatches` treats `.` and `:` as interchangeable, so an equality would miss `a:b` for the pattern `a.b`); those must still be matched in code.
- `AUDIT_SCAN_PAGE: number` — rows a driver should read per round-trip when a wildcard forces a scan (500). Bounds peak memory.

### `class MemoryAuditStore`

In-memory implementation of `AuditStore` (freezes each entry; filters and reverses on query), with the chain methods and `get` / `redact`. Ideal for dev and tests; does not persist.

### Redaction

Payloads are scrubbed before they are persisted. `redactSensitive` masks values under secret-looking keys as `'[redacted]'`; the opt-in `createPiiMinimizingRedactor({ key })` (or `redactSensitiveAndPii`) additionally replaces email/phone-shaped values, and values under common PII keys, with a `pii_<hmac>` pseudonym: HMAC-SHA256 under your key, truncated to 128 bits.

Secret keys are matched on the key's words (camelCase, `_`, `-` and `.` split), exported as `isSensitiveKey(key)`: anything containing `password`/`passwd`/`passphrase`/`passcode`, `secret`, `token`, `credential`, `authorization`, `cookie`, `apiKey`, `privateKey`, `accessKey`, `secretKey`, `signingKey`, `encryptionKey`, `connectionString`, `databaseUrl` or `passport`; a word `pwd`, `pass`, `jwt`, `auth`, `otp`, `totp`, `mfa`, `dsn`, `bearer` or `sid`; and `session`/`sessionId`/`sessionKey`. Words that merely contain those letters — `compass`, `bypass`, `author`, `sessionCount` — are kept. A `__proto__`, `constructor` or `prototype` key is kept as an own property with the value `'[redacted]'`, so a mass-assignment attempt stays visible in the trail instead of vanishing.

A **phone-shaped** value is one in international form: a leading `+` and 8–15 digits, optionally separated by spaces, dots, dashes or parentheses (`+351 912 345 678`, `+1 (555) 123-4567`). A bare digit string is not treated as a phone — it is as likely an order id or an amount — so keep national-format numbers under a PII key (`phone`, `msisdn`, …).

```ts
auditPlugin({ redact: createPiiMinimizingRedactor({ key: process.env.AUDIT_PII_KEY! }) })
```

The match is on the key, not the value, so a flag like `passwordProtected: true` or `mfaEnabled: false` is masked too. When such booleans belong in the trail, wrap the default redactor rather than weakening it — a boolean carries no secret:

```ts
import { auditPlugin, isSensitiveKey, redactSensitive, type AuditRedactor } from '@basaltkit/audit'

const keepBooleanFlags: AuditRedactor = (payload) => {
  const redacted = redactSensitive(payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return redacted
  // Top-level booleans under a secret-looking key are restored; everything else stays masked.
  const flags = Object.entries(payload).filter(([k, v]) => typeof v === 'boolean' && isSensitiveKey(k))
  return { ...(redacted as Record<string, unknown>), ...Object.fromEntries(flags) }
}

auditPlugin({ redact: keepBooleanFlags })
```

IP-address keys (`ip`, `ipAddress`, `clientIp`, `remoteAddr`, `x-forwarded-for`, matched exactly — not `zip` or `recipient`) count as PII too, and so does the entry's own `ip` field when `requestContext` is on.

Every value under a PII key is pseudonymized whatever its shape — a number, a list, or a nested object (each scalar leaf; secret-looking keys inside are still masked). The key must be a string or `Uint8Array` secret of at least 16 bytes (128 bits); keep it out of the audit database. With the key, the same value always maps to the same pseudonym, so entries stay correlatable; without it, a pseudonym cannot be reversed by hashing candidate emails or phone numbers. If no key is configured (`createPiiMinimizingRedactor()` or the `piiMinimizingRedactor` constant), a random per-process key is used and a warning is logged: pseudonyms are still irreversible but no longer correlate across restarts.

Both walk **6 levels deep**. Anything deeper is replaced with `'[truncated]'` — not passed through. Payloads are arbitrary and the default subscription is `events: ['**']`, so returning the raw subtree meant a secret nested seven levels down reached the trail in cleartext. If your payloads are deeply nested, flatten them before recording rather than relying on depth.

### Personal data per event

The redactors decide by key name and value shape, so they cannot know that the
`notes` of one event is health data. A value that reaches the trail can only be
erased later through [`audit.redact()`](#erasing-personal-data-auditredact) —
attested in the chain, and with an old hash that may still confirm a guess of
it. Declaring up front what must never be stored is cheaper and leaves nothing
behind:

```ts
auditPlugin({
  fieldPolicies: {
    'customer.created': { omit: ['notes', 'address.street'], pseudonymize: ['email', 'fullName'] },
    'order.placed': { pseudonymize: ['items[].buyer.phone'] },
  },
  fieldPolicyKey: process.env.AUDIT_PII_KEY!,
})
```

Keys are exact event or hook names. Paths are dotted, arrays are walked
transparently (`items[].x` spells it out), and absent paths are ignored. `omit`
removes the field; `pseudonymize` replaces every scalar under it with a
`pii_<hmac>` pseudonym, the same one `createPiiMinimizingRedactor` produces under
the same key. A path in both lists is omitted. The policy runs on a copy, for
`record()`, hooks and events, before the redactor and before hashing. Invalid
policies (unknown option, empty or `__proto__`/`constructor` segment, more than
8 segments) throw a `TypeError` at configuration time. Without `fieldPolicyKey`
a random per-process key is used and a warning is logged once.

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
There was no active context at record time. Make sure the code runs inside `runWithContext({ user, tenant }, …)` — in HTTP, this is established by the middleware. Outside a request (a script, a CLI command), you can instead pass `audit.record(event, payload, { tenantId, actorId })`; see "Manual records".

**Domain events aren't being recorded.**
Either `eventsPlugin()` isn't registered (`auditPlugin` only subscribes to the bus if `container.has(EVENTS)`), or you passed `events: []`, or the patterns don't match the event names.

**One of my hooks doesn't show up in the trail.**
The defaults only cover `auth/billing/tenancy/permission`, and leave out `auth:apikey_rejected`. Pass `hooks: [...]` with your own patterns — note that the list **replaces** the defaults, so include the ones you want to keep too; name a default-excluded hook exactly to record it.

**I lost the history after restarting.**
`MemoryAuditStore` is volatile. In production, implement `AuditStore` over a database.

**A deeply-nested field comes back as `'[truncated]'`.**
The redactors stop at 6 levels and drop everything below, so a secret can never slip past the depth bound. Flatten the payload (or record the interesting fields explicitly) if you need that data in the trail.

**Can I edit or delete an entry?**
No — the contract is append-only and entries are frozen. This is a feature, not a limitation: it's what gives the trail evidentiary value. To make that hold against someone with database access too, enable `integrity: 'hash-chain'`, revoke `UPDATE`/`DELETE` on the table, and run `basalt audit:verify` (see "Verifiable trail"). The one exception is **erasing personal data** with `audit.redact()` — and that is itself recorded in the chain as an `audit:redacted` entry that `verify` checks.

**`verify()` fails with `redaction-mismatch`.**
A redacted entry no longer matches its `audit:redacted` attestation (`detail` says how): its content, header fields or marker were changed after the erasure, the attestation is gone or edited, or the store cannot read it back (`get()`). When `entryId` is an attestation, its entry was un-erased (restored from a backup) or rolled back to an older redaction — re-apply your DSR ledger. Treat it as tampering.

**`audit.redact()` throws `AuditRedactionRefusedError`.**
Check `reason`: `'unverified'` — the entry does not verify as it is (investigate before erasing anything), or it is chained and this `Audit` has no integrity configured; `'residual'` — the chain is unkeyed, pass `residual: 'public'` to accept that the old hash can confirm a guess; `'unsupported-store'` — the store has no `get()` / `redact()` (upgrade the store package, or implement them).

**`verify()` reports `unchained` rows.**
They were written before `integrity` was enabled and carry no hash. They are not broken — just not verifiable. New entries are chained from `seq` 1.

**`verify()` fails with `unchained-entry`.**
A row of that tenant sits outside its chain although it was written after the chain began — inserted into the table by something other than `Audit` (check `unverified` for the ids). If it is a known, benign source — replicas still running without `integrity` during a rolling deploy — pass `legacyUntil` with the time integrity was fully on; otherwise treat it as tampering.

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
