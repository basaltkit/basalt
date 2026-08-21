# @basaltkit/prisma

## 1.2.0

### Minor Changes

- Refuse raw queries (`$queryRaw`/`$executeRaw`) inside a tenant context (`PRISMA_RAW_IN_TENANT`), and add Postgres RLS helpers (`rlsPolicySql`/`setTenantConfigSql`/`tenantConfigParams`) for database-enforced tenant isolation.

## 1.1.0

### Minor Changes

- **SECURITY (behavior change): the tenancy extension now fails closed.**
  `tenancyExtension`'s `onMissingTenant` now defaults to **`'error'`** — a query
  that runs with no tenant in context throws `MissingTenantError` instead of
  silently running **unscoped** (which returned/mutated every tenant's rows). This
  closes a critical cross-tenant exposure (a forgotten job/worker context, or a
  route hit before the tenancy enricher, previously leaked all tenants' data).
  Central/admin code that intentionally runs unscoped must now opt in explicitly
  with `tenancyExtension({ onMissingTenant: 'bypass' })`.


## 1.0.5

### Patch Changes

- `basalt prisma:sync` now also discovers `@basaltkit/tenancy-prisma`,
  `@basaltkit/events-prisma` and `@basaltkit/webhooks-prisma` — their
  `Tenant`/`TenantDomain`, `OutboxEntry` and `WebhookEndpoint` models merge into
  your `schema.prisma` like every other `@basaltkit/*-prisma`.

## 1.0.4

### Patch Changes

- Add the `basalt prisma:sync` command — discovers installed @basaltkit/*-prisma packages and merges their models into your prisma/schema.prisma (interactive by default; --yes/--all non-interactive, --only=, --push/--migrate, --schema=). Exports prismaSyncCommand + extractSchemaBlocks.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/cli@0.24.0
- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/cli@0.23.0
- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/cli@0.22.0
- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/cli@0.21.0
- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/cli@0.20.0
- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/cli@0.19.0
- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/cli@0.18.0
- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/cli@0.17.0
- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/cli@0.16.0
- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/cli@0.15.0
- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/cli@0.14.0
- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/cli@0.13.0
- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/cli@0.12.0
- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/cli@0.11.0
- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/cli@0.10.0
- @basaltkit/core@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/cli@0.9.0
- @basaltkit/core@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/cli@0.8.1
- @basaltkit/core@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/cli@0.8.0
- @basaltkit/core@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/cli@0.7.0
- @basaltkit/core@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/cli@0.6.0
- @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/cli@0.5.1
- @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/cli@0.5.0
- @basaltkit/core@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/cli@0.4.0
- @basaltkit/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0
  - @basaltkit/cli@0.3.0

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
