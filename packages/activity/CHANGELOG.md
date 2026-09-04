# @basaltkit/activity

## 1.2.0

### Minor Changes

- 6c9f1c7: `files-versions` reads the ambient tenant, like `Files` always did.
  
  `FileVersions` resolved its store key as `tenantId ?? SINGLE_TENANT_SCOPE`,
  skipping the request context. `Files.upload` does read the context, so the two
  disagreed: a multi-tenant application that passed no explicit `tenantId` — the
  normal case — wrote versions under `acme` and read them back under `'default'`.
  `history()` returned `[]` and `latest()` returned `null` for a document that
  existed, and `download()` raised `FileVersionNotFoundError` for a file sitting
  on the disk.
  
  A silent wrong answer, which is worse than the error it replaced, and precisely
  the failure this package was written to prevent. Its own README described the
  correct behaviour, not the implemented one.
  
  The rule now lives in one place. `@basaltkit/files` exports `fileScope()` and
  `resolveFileTenant()`, `Files` uses them internally, and `FileVersions` takes
  the same `tenancyActive` probe — wired by `fileVersionsPlugin` from the same
  `'tenancy:active'` marker `filesPlugin` reads. Two implementations of one rule
  is one too many.
  
  Single-tenant applications are unaffected: with no tenancy registered there is
  no tenant to resolve and the scope stays `SINGLE_TENANT_SCOPE`. That path is now
  exercised by the `beyond-saas` tripwire, which covered `files` but not
  `files-versions` — which is why this shipped.
  
  ---
  
  **`@basaltkit/activity` adopts the safe scope when tenancy is present.**
  
  `tenantScoped` defaulted to `true`, meaning "scope to the context tenant, and
  run **unscoped** when there is none". In a multi-tenant application a feed query
  made outside a tenant context therefore answered with every tenant's records —
  and an activity line is not an aggregate number, it reads "Dr. Kiala opened
  matter 2026/014 for Kwanza Lda": another firm's client, by name, in prose.
  
  `activityPlugin` now tightens to `'required'` when `@basaltkit/tenancy` is
  registered and the application expressed no preference — the same thing
  `@basaltkit/cache` already does, and what the framework's own rule asks for: a
  generic package never requires tenancy, but adopts safe defaults when it is
  there. A single-tenant app is untouched, and `tenantScoped: false` still wins
  for an operator console that means to read across tenants.

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1
  - @basaltkit/tenancy@1.4.2

## 1.1.0

### Minor Changes

- 92947e5: `tenantScoped: 'required'` — opt-in fail-closed query scoping.
  
  `Activity.query()` with the default `tenantScoped: true` auto-scopes when a tenant is in context but runs UNSCOPED when there is none (fail-open). The new `'required'` mode uses `@basaltkit/tenancy`'s `requireTenantId`: the context tenant always wins (a caller-supplied `query.tenantId` cannot widen the scope), an explicit `query.tenantId` is honoured when no tenant is in context, and otherwise the query throws `TenantRequiredError` instead of silently returning every tenant's records. Defaults are unchanged; `@basaltkit/tenancy` is a new (small, core-only) dependency.

### Patch Changes

- Updated dependencies [92947e5]
  - @basaltkit/tenancy@1.4.0

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
