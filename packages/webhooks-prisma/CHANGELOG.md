# @basaltkit/webhooks-prisma

## 2.1.0

### Minor Changes

- b7171e5: Webhook delivery limits and sender-side secret rotation (framework audit, "Melhorias" item 6).
  
  - **Port policy.** Deliveries used to go to any port of a public host, so an endpoint could point the sender at someone's exposed Redis (`:6379`), memcached (`:11211`), Postgres (`:5432`) or SMTP (`:25`). The SSRF guard now allows `80`, `443` and every port from `1024` up except `DEFAULT_BLOCKED_PORTS` (databases, caches, message brokers, cluster control planes, proxies, remote admin). Privileged ports other than HTTP(S) are refused. Configure with `ssrf.allowedPorts` (an array allows exactly those ports; `'any'` turns the policy off). The policy is enforced by `resolveAndValidate()` (before any DNS lookup, with `allowPrivateHosts` too), by every delivery (`WebhookUrlBlockedError`, `attempts: 0`, `retryable: false`) and by `register()` (`WebhookEndpointInvalidError`). Redirects are still never followed. New exports: `DEFAULT_BLOCKED_PORTS`, `isPortAllowed`, `effectivePort`, `WebhookDeliverer#allowsPort`.
  - **DNS resolution runs inside the per-attempt deadline.** `timeoutMs` now covers resolving the host and the request together. A resolver that hangs used to hold the delivery (and an outbox flush waiting on it) indefinitely. Now the attempt fails as a transient error (`host resolution timed out`, `retryable: true`) and the next attempt resolves again.
  - **Dispatch fan-out cap and concurrency.** `dispatch()` refuses a scope (one tenant, or the tenant-agnostic set) whose active endpoints matching the event exceed `maxEndpointsPerDispatch` (default 100, `false` disables it). None of that scope's endpoints is sent to. Each one gets a failed result (`fan-out cap exceeded…`, `retryable: false`), and `onFanOutExceeded` is called once per scope (default `console.warn`). Other scopes are unaffected. Deliveries now run at most `dispatchConcurrency` at a time (default 16) instead of all at once. Both options can be set on `webhooksPlugin` and `WebhookManager`.
  - **Sender-side secret rotation.** New `WebhookManager.rotateSecret(id, { graceSeconds?, secret?, tenantId?, system? })` rotates an endpoint's secret without breaking its receiver. For the grace window (default 24 h, at most 30 days, `0` for an immediate cut-over), every delivery is signed with both secrets (`t=…,v1=<new>,v1=<old>`), which `verifySignature` and other Stripe-style receivers accept. Before this, the README described rotation that only receivers supported. `WebhookEndpoint` gains the optional `previousSecret` and `previousSecretExpiresAt`. `list()` redacts both secrets. Re-registering an endpoint during a rotation ends the rotation. `signPayload()` accepts an array of secrets. New `WebhookEndpointNotFoundError` (404) and the `DEFAULT_SECRET_ROTATION_GRACE_SECONDS` / `MAX_SECRET_ROTATION_GRACE_SECONDS` constants.
  - **webhooks-sqlite:** `migrate()` adds the nullable `previous_secret` and `previous_secret_expires_at` columns, including to an existing table (`ALTER TABLE`).
  - **webhooks-prisma:** the reference schemas (`schema.prisma`, `schema.mysql.prisma`) add `previousSecret String?` (`@db.Text` on MySQL) and `previousSecretExpiresAt DateTime?`. The `'mysql'` column-limit preset covers `previousSecret`. The store writes these columns only when an endpoint carries rotation state, so a schema without them keeps working until you call `rotateSecret()`.
  
  **Why major (`@basaltkit/webhooks`):** endpoints on a blocked port that used to receive deliveries are now refused, both at `register()` and at delivery. Dispatches over 100 endpoints per event per scope are refused. Deliveries per dispatch are bounded to 16 in flight.
  
  Migration:
  - An endpoint that legitimately listens on a blocked port needs `ssrf: { allowedPorts: [...] }`, or `'any'`.
  - If a scope really has more than 100 endpoints for one event, raise `maxEndpointsPerDispatch`.
  - If a custom store should support rotation, it must persist `previousSecret`/`previousSecretExpiresAt` and, when `add()` gets those keys set to `undefined`, clear them.
  - Prisma users run `basalt prisma:sync` (or copy the two fields) and migrate before calling `rotateSecret()`.
  - `@basaltkit/drives` validates its outbound fetches with `resolveAndValidate`, so it gets the same port policy on every hop.

### Patch Changes

- Updated dependencies [b7171e5]
  - @basaltkit/webhooks@4.0.0

## 2.0.0

### Major Changes

- e53db52: Framework audit, pass 2 — persistent stores (FA-068, FA-069, FA-070).
  
  Major for tenancy-prisma, webhooks-prisma, webhooks-sqlite and auth-prisma: a generated PrismaClient still fits the new client interfaces (`$transaction`, `create`/`updateMany`), but hand-written clients and test fakes must add those methods, and cross-scope writes that used to succeed now throw.
  
  - **tenancy-prisma — `save()` / `create()` are atomic (FA-068).** The tenant
    row, the domain check and the domain set (`deleteMany` + `createMany`) now
    run in one interactive `$transaction`. Before, any failure after the delete —
    a domain listed twice, a domain another tenant claimed between the
    pre-flight and the insert, a lost connection — left the tenant rewritten with
    its existing domains gone. Duplicate domains in the array are stored once.
    `PrismaTenancyClient` now includes `$transaction` (a generated
    `PrismaClient` has it; a hand-written client must add it).
  - **webhooks-prisma — writes are keyed by `(id, tenantId)` (FA-069).**
    `add()` was an upsert by `id` alone: on MySQL's case-insensitive collation
    tenant A re-registering `ABC` rewrote tenant B's `abc` endpoint (url,
    secret, tenant). It is now an `updateMany` scoped to the endpoint's own
    tenant (or global scope), falling back to `create`; an id held by another
    scope throws the new `WebhookEndpointIdInUseError` (409). Re-adding an id in
    its own scope still replaces it. `PrismaWebhooksClient` now needs
    `create`/`updateMany` instead of `upsert` (a generated `PrismaClient` has
    them).
  - **webhooks-sqlite — no `INSERT OR REPLACE` across scopes (FA-070/D8).** The
    manager's check-before-write cannot stop two tenants registering the same id
    at once; the store now refuses an id held by another scope with
    `WebhookEndpointIdInUseError` (409) instead of overwriting that endpoint.
  - **auth-prisma — `touch()`/`revoke()` of a missing API key are no-ops
    (FA-070/I4)**, as in the other stores, instead of a Prisma `P2025` thrown
    out of `verify()`. The client surface uses `authApiKey.updateMany` (no longer
    `update`).
  - **auth-sqlite — email uniqueness without the NOCASE index (FA-070/D9).** A
    legacy database holding case-variant duplicates cannot build the
    case-insensitive unique index, and `migrate()` skipped it silently; `create`
    now refuses an email that exists in any letter case inside the `INSERT`
    itself, throwing `EmailTakenError` (409) — also for the race between two
    concurrent sign-ups.
  - **files-prisma — `prismaFilesStore()` fails fast** when the client has no
    `file` model, like every other `*-prisma` factory (FA-070/I4).
  - **permissions-sqlite — multi-permission grants are all-or-nothing**
    (FA-070/I5): `grantToRole` / `grantToUser` run in one savepoint.

### Minor Changes

- b69ea05: MySQL no longer truncates long values silently (framework audit FA-070).
  
  On MySQL Prisma maps a bare `String` to `VARCHAR(191)`, and a server outside
  strict mode cuts a longer value with only a warning: a webhook URL delivered
  elsewhere, a file `path` stopped naming its object, JSON payloads stopped
  parsing, and a truncated audit payload or hash broke the hash chain for good.
  
  - Each package ships **`schema.mysql.prisma`** (exported as
    `@basaltkit/<pkg>/schema.mysql.prisma`): the same models with the free-text
    columns widened (`@db.Text`, `@db.MediumText`, `@db.VarChar(255)`) and the
    keys left at `VARCHAR(191)`. `comments-prisma`'s variant stores `mentions` as
    `Json` (MySQL has no scalar lists); the store now reads either form.
  - Every factory and store class takes an optional **`columnLimits`**
    (`'mysql'` — the preset matching that schema, exported as
    `<domain>MysqlColumnLimits` — or your own per-model limits, in characters or
    `{ bytes }`). With it set, a value longer than its column is refused with
    `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`, 422) before anything is
    written. The outbox's diagnostic `lastError` is shortened (marked
    `…[truncated]`) instead, so `markFailed` still counts the attempt.
  - `basalt prisma:sync` (`@basaltkit/prisma`) copies the MySQL variant when the
    app's `datasource` provider is `mysql`, and warns about a package without one.
  
  Unset, nothing changes: PostgreSQL and SQLite are unaffected, and existing
  calls keep their signatures (the option is a new trailing parameter).

### Patch Changes

- b69ea05: `WebhookEndpointIdInUseError` is now the `@basaltkit/webhooks` class.
  
  Both stores defined their own error with the same `code`
  (`WEBHOOK_ENDPOINT_ID_IN_USE`) and `status` (409), so an `instanceof` check
  against the class `@basaltkit/webhooks` exports — which `MemoryWebhookStore`
  and `WebhookManager.register()` throw — missed a refusal from the SQLite or
  Prisma store. They now throw that class and re-export it under the same name,
  so existing imports from the store packages keep working and one `instanceof`
  covers every store. The message now starts with `@basaltkit/webhooks:`.
- Updated dependencies [b69ea05]
- Updated dependencies [e54b7b1]
  - @basaltkit/webhooks@3.0.0

## 1.2.0

### Minor Changes

- fb85c40: Security hardening, follow-ups to the outbox (F68) and SDK path-param (F73) fixes:
  
  - events: the outbox relay is fair across tenants, so a tenant whose downstream hangs cannot starve other tenants however many events it emits. When one tenant's backlog fills a page, `flush()` queries again with the tenants already seen excluded, then interleaves the batch round-robin by tenant (each tenant stays FIFO). New `OutboxOptions.tenantConcurrency` (default `ceil(concurrency / 2)`) caps one tenant's in-flight dispatches across flushes. New `dispatchTimeoutMs` (default 10 s, `false` to disable) bounds how long a flush waits on one dispatch. A slower dispatch keeps running detached: it is not cancelled or re-sent, its outcome is still recorded, and `FlushResult.detached` counts it. `OutboxStore.pending()` takes an optional `OutboxPendingFilter` (`excludeTenantIds`, `excludeGlobal`). Custom stores that ignore the filter still work, with fairness limited to one page. Single-tenant apps: tenant-less entries share one `tenantConcurrency` budget, so raise it to keep 8 parallel dispatches.
  - events-sqlite / events-prisma: `pending()` implements the tenant filter NULL-safely.
  - webhooks: `webhookOutboxPlugin` forwards `tenantConcurrency` and `dispatchTimeoutMs` and adds `onFlushError`. A store-level failure on a timer flush no longer becomes an unhandled rejection. `WebhookStore.forEvent(event)` with no tenant (`undefined`, `null` or `''`) is now fail-closed in `MemoryWebhookStore`, `SqliteWebhookStore` and `PrismaWebhookStore`: it returns tenant-agnostic endpoints only. `dispatch(..., { allTenants: true })` reads endpoints through `list()` instead.
  - sdk: a colon inside a path segment is literal again, so Google-style custom methods (`/v1/items:batch`, `/items/:id:archive`) work. Only a `:name` at the start of a segment is a placeholder, and `.`, `..`, empty or missing values are still refused with `CLIENT_INVALID_PARAM`.

### Patch Changes

- Updated dependencies [fb85c40]
- Updated dependencies [fb85c40]
  - @basaltkit/webhooks@2.0.0

## 1.1.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.1.0

### Minor Changes

- Security: `PrismaWebhookStore.remove(id, tenantId?)` now scopes the delete by `tenantId` when a tenant is given, so one tenant can't delete another's endpoint by id (see `@basaltkit/webhooks` 1.1.0).

## 1.0.5

### Initial release

- Prisma-backed `WebhookStore` for `@basaltkit/webhooks` — the production
  (PostgreSQL/MySQL) counterpart to the in-memory `MemoryWebhookStore`. Bring
  your own `PrismaClient`; ships a reference `schema.prisma` (`WebhookEndpoint`),
  discoverable by `basalt prisma:sync`.
- `prismaWebhookStore(client)` returns a store ready for `webhooksPlugin({ store })`,
  with `add`/`forEvent`/`list`/`remove`. Registered outbound endpoints survive a
  restart and can be shared across instances. Fails fast when the client lacks the
  `WebhookEndpoint` model.
