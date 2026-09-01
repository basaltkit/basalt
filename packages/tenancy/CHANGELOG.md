# @basaltkit/tenancy

## 1.5.0

### Minor Changes

- cccd980: **Creating a tenant can now provision its storage automatically.**
  
  Until now `basalt tenant:create` persisted the record and stopped, and the docs
  told you to write a `provisionTenant()` helper and remember to call it. That is
  operator-shaped: fine when a human runs `basalt tenant:migrate` next, and wrong
  for self-service signup, where the person clicking **Create** in a panel has
  neither the knowledge nor the access to run a migration. Meanwhile
  `subdomainResolver` routes the new tenant's traffic **the moment the record
  exists** — so the window between "saved" and "migrated" is a window in which the
  tenant is reachable and broken.
  
  ### `onProvision` on `tenancyPlugin`
  
  Declared once; runs on every creation path, inside the new tenant's context —
  the same contract as the `onMigrate` / `onSeed` hooks it sits beside.
  
  ```ts
  tenancyPlugin({
    source, resolvers,
    async onProvision(tenant) {
      const admin = new PrismaClient()
      await provisionTenantSchema(admin, tenantSchema(tenant.id))
      await migrateTenants({
        tenants: [tenant.id],
        target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
      })
    },
  })
  ```
  
  ### `tenancy.create(tenant)`
  
  The creation path that runs it. Persists → provisions → emits — in that order.
  
  ```ts
  await ctx().container.get(TENANCY).create({ id: 'acme', name: 'Acme' })
  ```
  
  `basalt tenant:create` now goes through it too, so the CLI and an admin route
  produce an identical tenant. Calling `source.create()` directly still works and
  still skips provisioning — the source only writes the row.
  
  ### `tenancy:created`
  
  Emitted **after** provisioning succeeds, so a listener may assume the tenant's
  storage exists — welcome email, audit entry, notifying a panel.
  
  ```ts
  app.hooks.on('tenancy:created', ({ tenant }) => notify(tenant))
  ```
  
  It does not fire if provisioning threw: a listener reacting to a half-built
  tenant is worse than one that never runs.
  
  ### Known edges, documented rather than hidden
  
  If `onProvision` throws, the error propagates and the hook stays silent — but
  **the tenant record already exists**, because the source persists first. That
  half-state is deliberately not rolled back: not every `TenantSource` can delete,
  and a failed delete on top of a failed provision destroys the evidence. Write
  `onProvision` idempotently so a retry finishes the job.
  
  It also runs **inline** — an HTTP handler calling `create()` waits for the
  migration. Right for a schema and a few migrations; hand anything slower to a
  queued job.
  
  New error: `TenantCreateUnsupportedError` (`TENANT_CREATE_UNSUPPORTED`) for a
  read-only `TenantSource`. Purely additive — existing apps are unaffected.

## 1.4.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.4.1

### Patch Changes

- a76d591: `tenancyPlugin` adds a `tenancy:active` entry to the metadata registry — a string-keyed marker other plugins read to adopt tenant-safe defaults (first consumer: `@basaltkit/cache`, which now fails closed on a missing tenant scope in multi-tenant apps). No behavior change in this package.

## 1.4.0

### Minor Changes

- 92947e5: Fail-closed tenant-scoping helpers: `requireTenant()`, `requireTenantId(fallback?)`, `tenantScoped(where?)` and `TenantRequiredError`.
  
  Repositories that derive the tenant from context risk the classic Prisma foot-gun: `where: { tenantId: ctx.tenant?.id }` with no tenant in context silently DROPS the filter and returns every tenant's rows. The helpers make the safe pattern one call:
  
  - `requireTenantId(fallback?)` — the context tenant always wins (anti-widening: caller/client input can never switch the scope), an explicit fallback is honoured when no tenant is in context (system jobs/CLI), and otherwise it THROWS `TenantRequiredError` instead of yielding `undefined`. Same hardened semantics as `Audit.trail()`.
  - `tenantScoped(where?)` — spread-ready `{ ...where, tenantId }` for repository where-clauses; `tenantId` is spread last so a smuggled value cannot override the context tenant.
  - `requireTenant()` — the whole `Tenant`, same rules.
  - `TenantRequiredError` — `TENANT_REQUIRED` with `status = 400`, so every adapter maps it to a client error, never a silent unscoped read.
  
  Strictly opt-in: nothing changes unless a repository author calls the helpers.

## 1.3.1

### Patch Changes

- 9f606fa: Security P2 — institutionalize:

  - **`@basaltkit/tenancy` (fix):** `normalizeDomain` now strips _all_ trailing dots,
    not just one — `example.com..` normalized to `example.com.` (non-idempotent),
    which could sidestep the custom-domain dedup/lookup. Found by a new property/fuzz
    test. Now idempotent and canonical for every input.
  - **`@basaltkit/ai`:** new `ai:doctor` security rule **`in-memory-security-store`** —
    warns when WebAuthn passkeys/challenges, roles & permissions, or verified custom
    domains are kept in an in-memory store (lost on restart, not shared across
    instances → lockouts or authorization drift in production).

  Also adds parser property/fuzz tests (SSE encoder injection-resistance, domain
  normalization totality/idempotence, TOTP roundtrip) that run in CI on every change.

## 1.3.0

### Minor Changes

- c305a67: Security hardening from a deep adversarial audit of this release's new components.

  - **dashboard (CRITICAL):** `brandingStyleSheet`/`brandingCssVars` now strictly validate custom-property names and values and drop anything that could break out of the `<style>` element — closes a tenant-controlled stored-XSS/CSS-injection vector in the white-label shell. Analytics `subscriptionMrr` uses `Number.isFinite` so `NaN`/`Infinity` prices can't poison MRR.
  - **auth:** the WebAuthn registration challenge is now bound to its subject — `finishRegistration` throws `WEBAUTHN_SUBJECT_MISMATCH` unless the `userId` matches the one `startRegistration` was called with (prevents binding a passkey to another account), rejects a duplicate credential id (`PASSKEY_EXISTS`) instead of overwriting, namespaces registration vs authentication challenges, validates the credential id type, and the in-memory challenge store now purges expired entries + caps size. **`WebAuthnChallengeStore` now stores/returns `StoredChallenge` objects** (was a bare string).
  - **tenancy:** custom-domain `verify`/`instructions`/`remove` are now tenant-scoped (`DomainForbiddenError`); a shared `normalizeDomain` (lowercase/port/trailing-dot/IDNA) is used by registration, lookup AND the Host resolver; `MemoryDomainStore.add` rejects duplicates atomically; `verify(tenantId, domain, { force })` re-checks DNS and **revokes** on failure (dangling-domain defence); new `findByVerifiedDomain` helper wires only verified domains into `TenantSource.findByDomain`.
  - **prisma:** `readReplica` gains `extend` (apply the same extension to primary AND every replica — prevents an un-scoped replica leaking all tenants) and routes `$queryRaw`/`$queryRawUnsafe` to the **primary by default** (opt back in with `rawReadsOnReplica`). `ShardRouter` defensively copies its shards.
  - **http:** SSE `encodeSseEvent` strips CR/LF/NUL from `id`/`event` (event-stream injection) and splits `data` on all line terminators; `send()` now returns a boolean backpressure signal.
  - **core:** `renderDependencyGraph` escapes token descriptions so a label can't break out of / inject HTML into the Mermaid node.

### Patch Changes

- Updated dependencies [c305a67]
  - @basaltkit/core@1.1.1

## 1.2.0

### Minor Changes

- bf8666c: Custom-domain management: register a tenant's own domain, prove ownership via a
  DNS TXT record, and let only **verified** domains resolve. Adds `CustomDomains`
  (add/verify/list/remove/tenantOf), `DomainStore` + `MemoryDomainStore`, and
  `DnsVerification`. Wire `tenantOf` into `TenantSource.findByDomain` so the
  existing `domainResolver` only maps verified domains. (TLS provisioning stays
  infrastructure — out of scope.)

### Patch Changes

- Updated dependencies [fd5b55c]
  - @basaltkit/core@1.1.0

## 1.1.0

### Minor Changes

- b2caf73: Add the `tenant:list|create|migrate|seed|run` CLI commands.

  `tenancyPlugin` now registers five commands into the CLI command bucket:

  - **`tenant:list`** — table of all tenants (needs `source.list`).
  - **`tenant:create <id> [--field=…]`** — persist a new tenant (needs the new optional `source.create`, implemented by `MemoryTenantSource`).
  - **`tenant:migrate [--tenant=<id>]`** / **`tenant:seed [--tenant=<id>]`** — run the per-tenant `onMigrate` / `onSeed` hooks (new plugin options) inside each tenant's context, for one tenant or all via `forEach`.
  - **`tenant:run <id> <command> [args…]`** — run any plugin-registered command inside a tenant's context.

  New `TenantSource.create?` and `TenancyPluginOptions.onMigrate` / `onSeed`.

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

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0

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
