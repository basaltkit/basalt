# @basaltkit/tenancy

## 1.9.0

### Minor Changes

- 30abb78: A tenant can be removed.
  
  `TenantSource` had `find`, `findByDomain`, `list`, `create` and `save`, and
  `Tenancy` had no `destroy`. There was no path out — not even an optional one.
  Two things followed.
  
  In tests, isolation suites reached for raw SQL:
  `$executeRawUnsafe('DROP SCHEMA "tenant_' + id + '" CASCADE')`. It normalises
  string interpolation into an SQL identifier, and the reason it was needed is
  worse than the pattern: without that cleanup, a schema left by a failed run
  makes the next provisioning a no-op, and every assertion below it passes green
  against the previous run's data. The suite stops testing anything and says
  nothing.
  
  In production, a self-serve signup that failed halfway left a PostgreSQL schema
  that nothing in the framework could remove.
  
  ```ts
  tenancyPlugin({ source, resolvers, onProvision, onDeprovision })
  
  await tenancy.destroy('acme')
  await tenancy.destroy('acme', { force: true })
  ```
  
  ```bash
  basalt tenant:destroy acme          # asks first
  basalt tenant:destroy acme --yes    # for scripts
  ```
  
  **The order of operations is the design**, and each step is where it is because
  the alternative loses something:
  
  1. **Mark `deleting`** — a new `TenantStatus`, so the resolver answers 503 and
     stops routing before anything is torn down. Dropping a schema out from under
     live requests produces errors nobody can interpret, from a tenant that looked
     healthy a second earlier.
  2. **Run `onDeprovision` inside the tenant's context**, exactly like
     `onProvision`, so a tenant-scoped client points at the storage being removed.
  3. **Delete the record last.** The record is the only thing naming that storage.
     Delete it first and a failed teardown orphans a schema nobody can find —
     which is the state this method exists to prevent.
  
  If teardown throws, the record survives marked `deleting` and the error
  propagates: the evidence is kept and a retry can finish. `force` removes the
  record anyway, for when the storage is already gone by other means; it is a
  deliberate way to orphan storage, so it is never the default.
  
  A source that cannot delete gets `TenantDeleteUnsupportedError` rather than a
  success it did not perform — a tenant that looks removed and still resolves is
  worse than one that never left. `MemoryTenantSource`, `tenancy-prisma` and
  `tenancy-sqlite` all implement `delete()`; the Prisma and SQLite sources keep
  their existing `remove()` as the older name.
  
  **`@basaltkit/testing` gains `withTenant(tenancy, id, fn)`** — provision, run,
  clean up, *including when the test throws*, which is the case that matters: a
  failing test that leaves its tenant behind makes the next run fail for a
  different reason. It also destroys a leftover of the same id before starting,
  because a previous run may have died between writing the record and creating the
  schema, and a suite should be able to recover on its own.

## 1.8.0

### Minor Changes

- c539a6b: **A route can now declare whether it needs a tenant, with `meta.tenant`.**
  
  Separating central routes from tenant routes meant listing paths in
  `required: { except }` — which puts the decision in a different file from the
  route it describes. Rename the URL and the exemption silently stops matching,
  with no error anywhere: the route just starts 404ing for callers who never sent
  a tenant.
  
  ```ts
  // Central: no tenant, ever.
  route({ method: 'GET', url: '/pricing', meta: { tenant: false }, handler })
  
  // Tenant: refuse the request if none resolved.
  route({ method: 'GET', url: '/invoices', meta: { tenant: true }, handler })
  ```
  
  `meta.tenant` overrides the app-wide `required` in both directions, which makes
  the useful combination possible: `required: true` to deny by default, and the
  handful of central routes — health check, landing page, sign-up, tenant
  creation — opting out next to their own handler, where a reviewer sees it.
  
  A central route still *resolves* a tenant when one is present, so `ctx().tenant`
  is populated on `acme.example.com/pricing`. Only the requirement is lifted. A
  non-boolean `meta.tenant` is ignored rather than guessed at, since `meta` is
  free-form and shared with every other plugin.
  
  `required: true`, `required: false` and `required: { except }` are unchanged, and
  remain the right tool for paths you do not own — routes mounted by another
  package.
  
  ### `@basaltkit/http`
  
  `RequestEnricher` now receives the `route` being served, so an enricher can read
  its `meta`. Guards already got this; enrichers did not, which is why tenancy
  could only look at the URL. The field is optional and additive — existing
  enrichers are unaffected — and it is passed from the shared pipeline, so it
  works identically on Fastify, Express and Hono.

## 1.7.0

### Minor Changes

- 32bafd6: **`required` can now exempt paths, so it is usable by apps that have public routes.**
  
  `required: true` rejects any request that resolved no tenant. It applied to
  every route, which most apps cannot live with: a health check has no tenant to
  send — a load balancer will never set the header — and neither does a landing
  page or a public pricing endpoint. The only way out was `required: false`, which
  drops the guard everywhere and leaves each handler to notice the absent tenant
  on its own.
  
  ```ts
  tenancyPlugin({
    source: tenants,
    resolvers: [headerResolver()],
    required: { except: ['/', '/health', '/openapi.json', /^\/public\//] },
  })
  ```
  
  Entries are exact strings or regular expressions, matched against the path
  without its query string, so `/health` also covers `/health?probe=1`. A URL that
  cannot be matched is treated as required — the guard fails closed.
  
  Exempting a path lifts only the tenant requirement. Auth, subscription checks
  and every other guard still run.
  
  `required: true` and `required: false` behave exactly as before.
  
  ### One detail that had to be right on all three adapters
  
  Adapters report the URL differently: Fastify and Express pass a path with its
  query (`/health?probe=1`), Hono passes an absolute URL
  (`http://host/health`). Comparing the raw string would have matched on two
  adapters and silently never on the third, turning an exemption into a 404 only
  on Hono. The path is normalised before matching, and all three shapes are
  covered by tests.
  
  Also exports `isTenantRequired(required, url)`.

## 1.6.0

### Minor Changes

- 3b76238: **A tenant can now say it is not ready yet, and provisioning can outlive the request.**
  
  Completes the provisioning work: 1.5.0 added `onProvision` and `tenancy:created`,
  but a tenant was routable the instant its record existed. Between "saved" and
  "migrated" it was reachable *and* broken, and the first request died on a raw
  database error.
  
  ### Status, and a truthful 503
  
  | Status | Serves | How |
  | --- | :---: | --- |
  | *(none)* | ✅ | Predates this feature — **treated as ready**, so upgrading does not take an estate offline |
  | `ready` | ✅ | `onProvision` succeeded |
  | `provisioning` | ❌ **503** | Record written, work unfinished |
  | `failed` | ❌ **503** | `onProvision` threw; the record is kept as evidence, not deleted |
  
  503 rather than 404: the tenant exists, it simply is not serving, and 503 is the
  status a client may retry.
  
  New: `TenantNotReadyError` (`TENANT_NOT_READY`), `TenantStatus`, `isTenantReady()`.
  
  ### `provision: 'deferred'`
  
  ```ts
  tenancyPlugin({ source, resolvers, onProvision, provision: 'deferred' })
  ```
  
  `create()` then returns as soon as the record is written, marked
  `provisioning` — and the resolver already answers 503 for it.
  
  **Nothing is scheduled for you.** Background work runs in another process, where
  a closure from this one cannot reach, so the worker re-enters with the id:
  
  ```ts
  const ProvisionTenant = defineJob({
    name: 'tenant.provision',
    handle: ({ id }: { id: string }) => ctx().container.get(TENANCY).provision(id),
  })
  
  await tenancy.create({ id })                    // returns immediately
  await queue.dispatch(ProvisionTenant, { id })
  ```
  
  `tenancy.provision(id)` is public for exactly this: it runs `onProvision`, flips
  the status and emits `tenancy:created` — the same finish line the inline path
  crosses. It keeps `@basaltkit/queue` out of this package entirely, so any
  scheduler works.
  
  ### Unchanged by default
  
  `provision` defaults to `'inline'` — existing apps behave exactly as before.
  Apps with no `onProvision` get no status stamped at all, because nothing would
  ever clear it.
  
  `MemoryTenantSource` gains `save()`, needed for the status transitions.

## 1.5.1

### Patch Changes

- eb96943: **Fix: `tenancy.create()` did not work with any durable tenant source.**
  
  Shipped broken in 1.5.0 and found immediately in a real app:
  
  ```
  TenantCreateUnsupportedError: The configured TenantSource does not implement create().
    at Tenancy.create (@basaltkit/tenancy/dist/index.js:47)
  ```
  
  …from `@basaltkit/tenancy-prisma`, a source that persists tenants perfectly
  well. `create()` required `TenantSource.create()`, but **neither durable source
  implements it** — `tenancy-prisma` and `tenancy-sqlite` both expose `save()`, an
  upsert with the identical signature. Only `MemoryTenantSource` has `create()`,
  so the entire provisioning flow worked only in tests.
  
  `tenancy.create()` now prefers `create()` and falls back to `save()`. `save()` is
  also declared on the `TenantSource` contract, which never mentioned it despite
  every durable source providing it.
  
  The error message was wrong too — it claimed the Prisma/SQLite sources implement
  `create()`. It now names both routes and what each source actually offers.
  
  ### Why it was missed
  
  Every test used `MemoryTenantSource` — the one source that happens to have
  `create()`. The regression guards added here run against the **real**
  `SqliteTenantSource` and `PrismaTenantSource`, because a fake with the right
  shape is exactly what failed to catch this.
  
  No API change: `onProvision`, `tenancy:created` and `tenancy.create()` behave as
  documented, now on every source that can persist.

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
