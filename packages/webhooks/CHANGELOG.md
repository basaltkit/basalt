# @basaltkit/webhooks

## 4.1.0

### Minor Changes

- 870075a: Export a streaming SSRF-guarded HTTP client for untrusted URLs: `createGuardedFetch({ maxBytes, timeoutMs, deadlineMs?, allowedHosts?, allowedSchemes?, maxRedirects?, allowPrivateHosts?, lookup?, transport?, defaultHeaders?, mapError? })`. Unlike `pinnedFetch`, it hands the response body back as a capped `Readable` (plus `text()`, `json()`, `arrayBuffer()`, `destroy()`). Every redirect hop is re-validated and IP-pinned (max 3 by default, credentials dropped across hosts), no `accept-encoding` is sent, and the byte cap is enforced mid-stream. Refusals throw `GuardedFetchError` (`kind`: `SSRF_BLOCKED` · `BODY_TOO_LARGE` · `TIMEOUT` · `TOO_MANY_REDIRECTS`, code `OUTBOUND_<kind>`), naming the host and never the URL. Also exported: `hostAllowed`, `capStream`, `pinnedStreamTransport`.
- 194931a: Operable webhooks (BK-084), all opt-in:
  
  - **Sealed secrets at rest** — `secretBox` (on `webhooksPlugin` and `WebhookManagerOptions`): an app-supplied `{ seal, open, isSealed? }` that `register()` / `rotateSecret()` apply before the store write (the current and the previous secret) and the manager reverses before each delivery. The context `{ endpointId, tenantId }` can be bound into the ciphertext. Legacy plaintext rows keep delivering (via `isSealed()` or a `WebhookSecretNotSealedError` from `open()`) and are sealed on the next rotation. Both calls still return the plaintext secret. No crypto dependency is added.
  - **Attempt telemetry** — `DeliveryResult.durationMs` (whole delivery) and an `onAttempt` deliverer option called after every attempt with `{ deliveryId, endpointId, tenantId?, event, attempt, ok, status?, durationMs, error?, at }`. Not awaited; a throwing hook is logged and swallowed. No delivery-log store and no response-body capture.
  - **Header prefix** — `headerPrefix` deliverer option (default `x-basalt`, validated `[a-z][a-z0-9-]{0,31}`) and a `webhookHeaderNames(prefix)` helper for receivers.
  
  Docs: sealing, telemetry, header prefix and a schema-per-tenant recipe (`prismaWebhookStore(tenantClient())`). The outbox relay supports per-tenant endpoints through `runInTenant` and `webhookOutboxPlugin({ tenantOnly: true })`, which ship in this release too.
- 1868e07: The webhook outbox now works when endpoints live per tenant (a store over `tenantClient()` under schema- or database-per-tenant). Before this change every relayed entry failed with `DB_UNAVAILABLE` and dead-lettered.
  
  - New `runInTenant` option on `WebhookManager` and `webhooksPlugin`. An off-request `dispatch()` scoped by an explicit `tenantId`, with no tenant in context, runs its endpoint lookup inside that tenant. Only the store read runs there: secrets are opened and deliveries sent after the run has ended, so a slow endpoint never holds the tenant's pooled database client. `webhooksPlugin` wires it automatically to `@basaltkit/tenancy`'s `'tenancy:run'` signal, resolved per dispatch so plugin order does not matter. This covers `webhookOutboxPlugin`, the `outboxPlugin({ dispatch: webhookOutboxDispatch(container.get(WEBHOOKS)) })` recipe, manual flushes and your own jobs. A tenant already in context still wins, and the runner is not called then.
  - New `tenantOnly` option on `webhookOutboxPlugin`: capture only events emitted inside a tenant context. Set it when endpoints live per tenant.
  - New exported type `TenantRunner`, declared structurally (no dependency on `@basaltkit/tenancy`).
  
  Behaviour change — on by default. With `tenancyPlugin` registered, every dispatch scoped by an explicit `tenantId` outside a tenant context now runs its endpoint lookup inside `tenancy.run`, whatever the store's layout (shared schema and central webhook tables included). Per such dispatch:
  
  - one `TenantSource.find` call. A transient failure of it (the tenant directory is unreachable) rejects the dispatch, and an outbox entry is retried like any failed delivery;
  - `tenancy:switched` and `tenancy:exited` hooks fire, so every listener runs. Under schema- or database-per-tenant, `prismaPlugin` leases the tenant's pooled client for the duration of the lookup, even when the webhook store is central (a plain client) and never uses it: the lease can open or evict a pool slot, waits up to `acquireTimeoutMs` when the pool is saturated, and then fails with `PRISMA_POOL_EXHAUSTED`;
  - a tenant that no longer exists rejects with `TENANT_NOT_FOUND`, and an id that fails the tenant-id grammar rejects with `TENANT_ID_INVALID`, both before any delivery. The outbox relay retries such an entry and dead-letters it after `maxAttempts` instead of delivering it.
  
  Set `webhooksPlugin({ runInTenant: false })` when the webhook tables are central (shared schema, or a plain client under schema- or database-per-tenant). The lookup does not need the tenant there, and opting out removes the per-dispatch `find`, hooks and pool lease. A deleted tenant's endpoints then keep receiving deliveries until you remove them. Keep the default when endpoints live per tenant (`tenantClient()`).
  
  The fix needs `@basaltkit/tenancy` with the `'tenancy:run'` signal (this release's minor). With an older tenancy, behaviour is unchanged. A `WebhookManager` you construct yourself gets no runner unless you pass `runInTenant`.
- bbb8463: `signPayload()` and `verifySignature()` now accept the body as a `string` or as bytes (`Buffer` / `Uint8Array`), so a receiver can verify the exact bytes of a `rawBody()` route — including bodies that are not valid UTF-8, such as forwarded `message/rfc822` mail — without a lossy decode. The HMAC runs over `${t}.` followed by the body bytes (a string is UTF-8 encoded), so existing string signatures are byte-identical. A body that is neither a string nor bytes now verifies as `false` (and `signPayload` throws a `TypeError`) instead of being coerced with `String()`.

### Patch Changes

- Updated dependencies [7a3fd88]
  - @basaltkit/core@1.6.0

## 4.0.0

### Major Changes

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

## 3.0.0

### Major Changes

- b69ea05: Framework audit residuals (FA-070 D8 and the SSRF/registration follow-ups).
  
  - **`MemoryWebhookStore.add()` refuses an id held by another scope**, like the SQLite and Prisma stores: re-adding an id replaces it only within the same tenant (or global), and a cross-scope id throws the new `WebhookEndpointIdInUseError` (`WEBHOOK_ENDPOINT_ID_IN_USE`, 409). The check and write are atomic, so two concurrent `register()` calls with the same id from two tenants no longer let the second overwrite the first. `WebhookManager.register()` throws the same error from its pre-check (it used to be a plain `Error`).
  - **`register()` validates the endpoint before storing it.** A `url` that is not an absolute URL, a scheme outside the deliverer's allowlist (`ssrf.allowedSchemes`, default `http:`/`https:` — new `WebhookDeliverer.allowedSchemes` getter), a `secret` shorter than `MIN_WEBHOOK_SECRET_LENGTH` (16), or an empty/invalid `events` list throws the new `WebhookEndpointInvalidError` (`WEBHOOK_ENDPOINT_INVALID`, 400). These endpoints used to be stored and then fail on every delivery. Host reachability is still checked at delivery time.
  - **SSRF guard blocks more special-purpose ranges:** the documentation networks `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, the deprecated 6to4 relay anycast `192.88.99.0/24`, and the IPv6 documentation prefix `3fff::/20` (RFC 9637) — including when embedded in IPv4-mapped, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses. (`198.18.0.0/15`, `240.0.0.0/4`, `100.64.0.0/10` and `2001:db8::/32` were already blocked.)
  
  **Why major:** `register()` now throws for endpoints it used to accept (bad URL, short secret, empty events), and `MemoryWebhookStore.add()` throws where it used to overwrite another tenant's endpoint. Migration: validate endpoint input before calling `register()` (or map `WEBHOOK_ENDPOINT_INVALID` to a 400); custom stores should refuse cross-scope ids in `add()` the same way.
- e54b7b1: Security and correctness fixes from the framework audit (FA-021..FA-027).
  
  - **`null` means absent (FA-021).** A SQL row with `secret: null` crashed `deliver()` with a `TypeError`, and `tenantId: null` was treated as tenant-bound (refused with "tenant endpoint has no own secret"). Both are now treated exactly like a missing field. `dispatch()` is also resilient: an endpoint whose delivery throws becomes a failed result (`error: 'internal delivery error'`, logged server-side) instead of rejecting the whole dispatch.
  - **`unregister()` re-verifies ownership (FA-022).** With a tenant (ambient or explicit), the manager only calls `store.remove` when the endpoint is in that tenant's own `list()` (re-filtered), so a store whose `remove` ignores the tenant can no longer be used for a cross-tenant delete. The README example store now takes and honours `tenantId`.
  - **Outbox: stable delivery ids, no re-dispatch of permanent failures (FA-023).** Deliveries made through `webhookOutboxDispatch` carry an `id` derived from the outbox entry id and the endpoint id (`deriveDeliveryId`), identical across outbox retries and restarts. An entry is re-queued only for retryable failures (network, timeout, `5xx`, `408`/`429`); a retry skips endpoints that already accepted it. Permanent failures (SSRF-blocked, redirect, other `4xx`, refused secret) go to the new `onPermanentFailure` hook (default `console.warn`). New: `DeliveryResult.retryable`, `dispatch(…, { idempotencyKey, skipEndpointIds })`, `deliver(…, { deliveryId })`.
  - **`verifySignature()` rejects an invalid tolerance (FA-024).** A `toleranceSeconds` that is not a finite number ≥ 0 (e.g. `NaN` from an unset env var) or a non-finite `nowSeconds` now throws a `RangeError` instead of accepting a signature of any age.
  - **Custom `fetchImpl` and DNS pinning (FA-025).** New `pinnedFetch` — a `fetch`-compatible client over the pinned transport that honours `init[PINNED_ADDRESS]` — for wrappers that must keep rebind protection; declare such a client with `fetchImplPinsAddress: true`. Any other custom `fetchImpl` (with the SSRF guard on) emits a one-time `BASALT_WEBHOOKS_UNPINNED_FETCH` process warning and has its host re-validated before every retry. The README no longer claims the default is global `fetch`.
  - **No internal-DNS oracle (FA-026).** A URL blocked on a DNS verdict reports one generic error (`host does not resolve to an allowed public address`) with no resolved address, identical for "private" and "unresolvable"; the address is kept on `WebhookUrlBlockedError.resolvedAddress` for server-side logs only.
  - **Each retry is signed with its own timestamp (FA-027)**, so a retry after a long backoff still passes the receiver's replay tolerance. The signed body is unchanged across attempts.
  
  **Why major:** no export or option was removed, but behaviour that existing code can observe changed (all of it on broken or unsafe paths): `verifySignature` now throws only for a tolerance that silently disabled replay protection; the outbox stops re-queuing failures that could never succeed (they previously ended dead-lettered after re-delivering duplicates to healthy endpoints — hook `onPermanentFailure` to alert on them); the DNS-blocked `error` string is intentionally less specific. A custom `WebhookManager` stand-in used with `webhookOutboxDispatch` now receives an options object (`{ tenantId, idempotencyKey, skipEndpointIds }`) as the third `dispatch` argument, which the real manager already accepted.

### Patch Changes

- Updated dependencies [e54b7b1]
  - @basaltkit/core@1.5.0

## 2.0.0

### Major Changes

- fb85c40: Security hardening for webhooks and the outbox:
  
  - webhooks: a dispatch with no tenant now reaches only tenant-agnostic endpoints (explicit `{ allTenants: true }` for system fan-out); with tenancy active, `register`/`list`/`unregister` without a tenant throw `WebhookTenantRequiredError` unless `{ system: true }`; `list()` no longer returns signing secrets (`hasSecret` instead).
  - webhooks: the SSRF guard now classifies IPv6 addresses over their parsed bytes, so IPv4-mapped/compatible, NAT64, 6to4 and other special-purpose forms of private addresses are refused.
  - webhooks: tenant endpoints get their own generated signing secret (returned once by `register()`); tenant endpoints are never signed with the plugin-wide secret and deliveries are never sent unsigned by default (`allowSharedSecret` / `allowUnsigned` opt-outs); secrets under 16 characters are refused and `verifySignature` returns `false` for them; each delivery carries a signed unique `id` (`x-basalt-delivery`) and `endpointId`.
  - webhooks: delivery closes the connection once the response status is known instead of draining the body.
  - events: `Outbox` no longer lets entries in backoff occupy the batch, dispatches a batch with bounded parallelism (`concurrency`, default 8), and `MemoryOutboxStore` prunes old published entries (`retainPublished`, default 1000). `webhookOutboxPlugin` forwards `concurrency`.
- fb85c40: Security hardening, follow-ups to the outbox (F68) and SDK path-param (F73) fixes:
  
  - events: the outbox relay is fair across tenants, so a tenant whose downstream hangs cannot starve other tenants however many events it emits. When one tenant's backlog fills a page, `flush()` queries again with the tenants already seen excluded, then interleaves the batch round-robin by tenant (each tenant stays FIFO). New `OutboxOptions.tenantConcurrency` (default `ceil(concurrency / 2)`) caps one tenant's in-flight dispatches across flushes. New `dispatchTimeoutMs` (default 10 s, `false` to disable) bounds how long a flush waits on one dispatch. A slower dispatch keeps running detached: it is not cancelled or re-sent, its outcome is still recorded, and `FlushResult.detached` counts it. `OutboxStore.pending()` takes an optional `OutboxPendingFilter` (`excludeTenantIds`, `excludeGlobal`). Custom stores that ignore the filter still work, with fairness limited to one page. Single-tenant apps: tenant-less entries share one `tenantConcurrency` budget, so raise it to keep 8 parallel dispatches.
  - events-sqlite / events-prisma: `pending()` implements the tenant filter NULL-safely.
  - webhooks: `webhookOutboxPlugin` forwards `tenantConcurrency` and `dispatchTimeoutMs` and adds `onFlushError`. A store-level failure on a timer flush no longer becomes an unhandled rejection. `WebhookStore.forEvent(event)` with no tenant (`undefined`, `null` or `''`) is now fail-closed in `MemoryWebhookStore`, `SqliteWebhookStore` and `PrismaWebhookStore`: it returns tenant-agnostic endpoints only. `dispatch(..., { allTenants: true })` reads endpoints through `list()` instead.
  - sdk: a colon inside a path segment is literal again, so Google-style custom methods (`/v1/items:batch`, `/items/:id:archive`) work. Only a `:name` at the start of a segment is a placeholder, and `.`, `..`, empty or missing values are still refused with `CLIENT_INVALID_PARAM`.

### Patch Changes

- Updated dependencies [fb85c40]
- Updated dependencies [fb85c40]
  - @basaltkit/events@1.2.0

## 1.4.2

### Patch Changes

- 21a7d15: `verifySignature` now accepts a header with several `v1=` signatures and returns `true` when any of them matches, so receivers keep verifying while a sender rotates its secret (signing with both the new and the old one). Previously only the last `v1` was checked. Parsing is also stricter and more tolerant: a duplicate `t` is rejected, unknown schemes and spaces after commas are ignored.

## 1.4.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1
  - @basaltkit/events@1.1.1

## 1.4.0

### Minor Changes

- cc4786e: **Security (A-1): `list()` and `dispatch()` are forced to the ambient tenant — fail-closed against scope widening.** `register`/`unregister` already bound themselves to the context tenant, but `list(tenantId?)` and `dispatch(event, data, tenantId?)` trusted the caller's argument outright: a route handler forwarding client input (or simply calling `hooks.list()` inside a tenant request) returned every tenant's endpoints, and a manual `dispatch()` without the argument delivered one tenant's event data to every other tenant's endpoints. Both now follow the same anti-widening rule as `Audit.trail()` and `requireTenantId`: a tenant in the ambient context always wins over any caller-supplied `tenantId`; the explicit argument and the system-wide behavior remain available only where there is no ambient tenant (jobs, CLI relays, single-tenant apps — unchanged there). Flagged as a behavior change in the previously fail-open branch; it is the security-correct direction.

### Patch Changes

- Updated dependencies [cc4786e]
  - @basaltkit/events@1.1.0

## 1.3.0

### Minor Changes

- 2031bfb: Add a durable, at-least-once integration-events bridge over the app's own
  webhooks. `webhookOutboxPlugin({ events, store, intervalMs })` captures domain
  events into a transactional outbox (from `@basaltkit/events`) and relays them to
  webhook subscribers with retries — unlike `webhooksPlugin({ events })`, which is
  fire-and-forget and loses events on failure or a crash. `webhookOutboxDispatch
(webhooks)` is the underlying `OutboxDispatch` for manual wiring; resolve the
  `OUTBOX` token to enqueue or flush yourself (e.g. from a queue worker).

## 1.2.0

### Minor Changes

- Pin the outbound connection to the SSRF-validated IP to defeat DNS-rebinding (custom `lookup`); Host/SNI preserved.

## 1.1.0

### Minor Changes

- Security hardening (SSRF + tenant scoping):
  - **SSRF guard on delivery (HIGH).** The delivery URL is customer-supplied and was POSTed with no validation, so a tenant could point it at internal infrastructure — `http://169.254.169.254/` (cloud metadata), `localhost`, `10.x`/`192.168.x`/`172.16.x`, `[::1]`, etc. Every delivery is now validated first (`assertDeliverableUrl`): the scheme must be http(s), and the host must not be — or resolve to — a private, loopback, link-local, CGNAT, ULA or reserved address (the hostname is resolved and _every_ returned address checked, catching a name pointed at an internal IP). Redirects are no longer followed (`redirect: 'manual'`) so a 3xx can't bounce into an internal address. A blocked URL fails immediately without retry. Opt out for trusted self-hosted internal delivery with `ssrf: { allowPrivateHosts: true }`, or disable entirely with `ssrf: false`. Exposes `assertDeliverableUrl`, `isPrivateIp`, `WebhookUrlBlockedError`.
  - **Endpoints are bound to the registering tenant (MEDIUM).** `register` now stamps the current tenant (from context) onto the endpoint, so a tenant can no longer register a tenant-less endpoint that would receive _every_ tenant's event payloads. A caller-supplied `tenantId` can't override the ambient one.
  - **`unregister` is tenant-scoped (MEDIUM, IDOR).** `WebhookStore.remove(id, tenantId?)` now only deletes when the tenant owns the endpoint; `unregister` passes the current tenant, so one tenant can't delete or (via upsert) hijack another's endpoint by id.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0
- @basaltkit/events@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/events@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/events@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/events@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/events@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/events@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/events@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/events@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/events@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/events@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/events@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/events@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/events@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/events@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/events@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/events@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/events@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/events@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/events@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/events@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1
- @basaltkit/events@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/events@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0
- @basaltkit/events@0.4.0

## 0.3.0

### Minor Changes

- 252b1f7: Two new packages:

  - `@basaltkit/flags` — feature flags evaluated against a context (falling back to the request's tenant/user), with per-tenant and per-user overrides, deterministic percentage rollouts, and custom rules. `defineFlags`, `flagsPlugin`, `FLAGS`.
  - `@basaltkit/webhooks` — outbound webhooks with HMAC-signed delivery (Stripe-style `t=…,v1=…`), retries with exponential backoff, per-tenant subscriptions, and automatic tenant-scoped dispatch from domain events. `webhooksPlugin`, `WEBHOOKS`, `WebhookDeliverer`, `verifySignature`.

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0
  - @basaltkit/events@0.3.0
