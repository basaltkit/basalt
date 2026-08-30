# @basaltkit/webhooks

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
