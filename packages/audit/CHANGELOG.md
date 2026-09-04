# @basaltkit/audit

## 1.4.1

### Patch Changes

- 36ab1a1: Stop the default configuration from breaking tenant provisioning, and add
  `onCaptureError`.
  
  Two independent problems, both from `tenancy:**` being in the default hook
  patterns:
  
  **Tenant creation failed outright.** `tenancy.provision()` runs the provisioning
  callback inside the new tenant's context, which emits `tenancy:switched`. With
  an `AuditStore` bound to the tenant's own database — the natural setup for
  schema-per-tenant — that write hit storage that did not exist yet. The awaited
  listener had no `try/catch`, so the rejection propagated out through
  `provision()`, which marked the tenant `failed` and rethrew. An application
  following the defaults could not create a single tenant.
  
  **The trail filled with routing noise.** `tenancy:switched` also fires on every
  HTTP request that resolves a tenant, so a multi-tenant app wrote one audit row
  per request, forever.
  
  The default patterns now name `tenancy:created` instead of `tenancy:**`: tenant
  lifecycle is worth auditing, context switching is routing. The two were only
  together because one wildcard covered both.
  
  Bridged captures — hooks and events the plugin picks up automatically — no
  longer propagate failures into the operation that emitted them. `onCaptureError`
  reports them, defaulting to a log; the same rule `@basaltkit/realtime` applies to
  its own bridge. A deliberate `audit.record()` still throws, because there the
  audit *is* the operation.
  
  Apps that want the old capture set can pass `hooks: ['auth:**', 'billing:**',
  'tenancy:**', 'permission:**']` explicitly.

## 1.4.0

### Minor Changes

- f3703a1: `trail()` no longer requires tenancy: it fails closed only when `@basaltkit/tenancy` is registered.
  
  `Audit.trail()` threw whenever it could not resolve a tenant — but in an app with no `tenancyPlugin`, `ctx().tenant` is *always* undefined, so the everyday read threw every time and pushed developers onto `systemTrail()`, which the docs (correctly) frame as a dangerous system-only escape hatch. `@basaltkit/audit` is a general-purpose package; requiring the opt-in SaaS layer to read your own audit trail broke the [beyond-SaaS](https://basalt.dev/guide/beyond-saas) promise.
  
  `auditPlugin` now reads tenancy's `tenancy:active` metadata marker — the same signal `@basaltkit/cache` uses — and passes it to `Audit`. A **signal, not an import**: `@basaltkit/audit` still has no dependency on `@basaltkit/tenancy`.
  
  | App | `trail()` with no context tenant and no `tenantId` |
  |---|---|
  | No `tenancyPlugin` | Returns the trail (**changed** — used to throw) |
  | `tenancyPlugin` registered | Still throws, pointing at `systemTrail()` (unchanged) |
  
  Everything else is untouched: a context tenant still FORCES the scope and a caller-supplied `tenantId` still cannot widen it, an explicit `trail({ tenantId })` is still honoured, and `systemTrail()` remains the deliberate cross-tenant read. Multi-tenant apps see no behavior change; single-tenant apps get a bug fix. `new Audit(store, redact, tenancyActive?)` takes an optional third argument (defaults to single-tenant).

## 1.3.0

### Minor Changes

- 104cfb3: The redactors truncate past their depth limit instead of passing the raw subtree through.
  
  Both `redactSensitive` and `redactSensitiveAndPii` stopped at depth 6 by returning the value **unchanged**. Audit payloads are arbitrary and the default subscription is `events: ['**']`, so a `password` nested seven levels deep was persisted to the trail in cleartext — verified. Objects past the bound now become `'[truncated]'`; primitives (whose keys were already checked one level up) are unaffected, so nothing within the limit changes.
  
  Also adds `exactEventMatch()` and `AUDIT_SCAN_PAGE`, the shared helpers the store drivers use to push a query's limit down into the database.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1
  - @basaltkit/events@1.1.1

## 1.2.0

### Minor Changes

- `trail()` now forces the context tenant (a caller-supplied `tenantId` cannot widen scope); add `systemTrail()` for explicit cross-tenant reads and an opt-in `piiMinimizingRedactor`.

## 1.1.0

### Minor Changes

- Security hardening (secret redaction + tenant scoping):
  - **Payloads are redacted before storage by default.** The trail captured `auth:**`/`billing:**` hook payloads verbatim, so a password, session/API token or other secret in an event was written to the audit store in plaintext. Payloads now pass through `defaultAuditRedactor`, which recursively masks common secret keys (`password`, `token`, `secret`, `authorization`, `api-key`, `session`, `cookie`, `otp`/`mfa`, …) as `[redacted]`. Override with the `redact` option (`(p) => p` to keep the old verbatim behavior). Exposes `redactSensitive` / `defaultAuditRedactor`.
  - **`trail()` auto-scopes to the current tenant.** It passed the query straight to the store with no default tenant filter (unlike `Activity.query`), so a caller forwarding a client-supplied query — or omitting `tenantId` — could read across tenants. `trail()` now scopes to `ctx().tenant` when one is in context and the query didn't pin a tenant; a system caller outside a tenant context can still query broadly.

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

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0
  - @basaltkit/events@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
  - @basaltkit/events@0.1.0
