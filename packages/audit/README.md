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

By default, hooks matching `auth:**`, `billing:**`, `tenancy:**`, or `permission:**` are recorded. You can replace the list:

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

Event patterns support segments separated by `:` (hooks) or `.` (events): `*` matches one segment, `**` matches one or more. E.g.: `auth:*` matches `auth:login`; `order.**` matches `order.created` and `order.item.added`; `**` matches everything.

### Custom store (production)

`MemoryAuditStore` loses everything when the process ends. In production, implement `AuditStore` over your database — the contract is append-only (no update or delete):

```ts
import type { AuditEntry, AuditQuery, AuditStore } from '@basaltkit/audit'
import { auditPlugin } from '@basaltkit/audit'

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
| `hooks` | `string[]` | No | `['auth:**', 'billing:**', 'tenancy:**', 'permission:**']` | Hook patterns recorded automatically (replaces the defaults). |
| `events` | `string[]` | No | `['**']` (everything) | EventBus event patterns recorded. `[]` disables it. |

### `class Audit`

| Method | Signature | Description |
|---|---|---|
| `constructor` | `new Audit(store: AuditStore)` | Creates the facade over a store. |
| `record` | `(event: string, payload?: unknown) => Promise<AuditEntry>` | Manual entry (`source: 'manual'`), enriched from context. Returns the entry. |
| `trail` | `(query?: AuditQuery) => Promise<AuditEntry[]>` | Query, most recent first. |
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
| `at` | `number` | Timestamp (`Date.now()`, milliseconds). |

### `interface AuditQuery`

| Field | Type | Required? | Default | Description |
|---|---|---|---|---|
| `event` | `string` | No | all | Wildcard pattern over the name (e.g. `'auth:**'`). |
| `tenantId` | `string` | No | all | Filters by tenant. |
| `actorId` | `string` | No | all | Filters by actor. |
| `since` | `number` | No | since forever | Only entries with `at >= since`. |
| `limit` | `number` | No | no limit | Maximum number of results. The SQL-backed stores push it into the database, so a limited query never loads the whole trail. |

### `interface AuditStore`

Storage contract, **append-only by contract** (no update/delete):

- `append(entry: AuditEntry): Promise<void>`
- `query(query: AuditQuery): Promise<AuditEntry[]>` — must return most recent first and apply filters/limit.

Two helpers exist so a driver can push the limit down safely:

- `exactEventMatch(pattern?: string): string | undefined` — the event filter that may be pushed into SQL as an equality. Returns `undefined` for a pattern containing `*` (a wildcard) **or** `.` (because `patternMatches` treats `.` and `:` as interchangeable, so an equality would miss `a:b` for the pattern `a.b`); those must still be matched in code.
- `AUDIT_SCAN_PAGE: number` — rows a driver should read per round-trip when a wildcard forces a scan (500). Bounds peak memory.

### `class MemoryAuditStore`

In-memory implementation of `AuditStore` (freezes each entry; filters and reverses on query). Ideal for dev and tests; does not persist.

### Redaction

Payloads are scrubbed before they are persisted. `redactSensitive` masks values under secret-looking keys (`password`, `token`, `api_key`, `authorization`, …) as `'[redacted]'`; the opt-in `redactSensitiveAndPii` / `piiMinimizingRedactor` additionally replaces email/phone-shaped values with a stable `pii_<hash>` pseudonym.

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
No — the contract is append-only and entries are frozen. This is a feature, not a limitation: it's what gives the trail evidentiary value.

**What's the difference between `:` and `.` in names?**
Convention: lifecycle hooks use `:` (`auth:login`); domain events use `.` (`order.created`). `patternMatches` treats both as segment separators.

## How it connects to other modules

- **`@basaltkit/core`** — lifecycle hooks (`hooks.onAny`) are the primary capture source; the ALS context (`tryCtx`) supplies actor/tenant/requestId; the plugin uses `definePlugin`/`createToken`.
- **`@basaltkit/events`** — secondary capture source: any domain event emitted on the `EventBus` can land in the trail (`events` patterns).
- **`@basaltkit/activity`** — sibling module with a different focus: **activity** is the "human-friendly" feed shown to the user ("Maria published the project"); **audit** is the automatic, immutable security/compliance record.
- **`@basaltkit/logger`** — logs are ephemeral technical diagnostics; audit is durable business record. Use both.
- **`@basaltkit/queue`** — since context travels to workers, entries recorded inside a job retain the actor/tenant of the original request.
