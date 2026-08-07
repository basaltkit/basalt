# @machize/dashboard

## 0.19.0

### Patch Changes

- @machize/admin@0.19.0
- @machize/subscriptions@0.19.0

## 0.18.0

### Patch Changes

- @machize/admin@0.18.0
- @machize/subscriptions@0.18.0

## 0.17.0

### Patch Changes

- @machize/admin@0.17.0
- @machize/subscriptions@0.17.0

## 0.16.0

### Patch Changes

- @machize/admin@0.16.0
- @machize/subscriptions@0.16.0

## 0.15.0

### Patch Changes

- @machize/admin@0.15.0
- @machize/subscriptions@0.15.0

## 0.14.0

### Patch Changes

- @machize/admin@0.14.0
- @machize/subscriptions@0.14.0

## 0.13.0

### Patch Changes

- @machize/admin@0.13.0
- @machize/subscriptions@0.13.0

## 0.12.0

### Patch Changes

- @machize/admin@0.12.0
- @machize/subscriptions@0.12.0

## 0.11.0

### Patch Changes

- @machize/admin@0.11.0
- @machize/subscriptions@0.11.0

## 0.10.0

### Patch Changes

- @machize/admin@0.10.0
- @machize/subscriptions@0.10.0

## 0.9.0

### Patch Changes

- @machize/admin@0.9.0
- @machize/subscriptions@0.9.0

## 0.8.1

### Patch Changes

- @machize/admin@0.8.1
- @machize/subscriptions@0.8.1

## 0.8.0

### Patch Changes

- @machize/admin@0.8.0
- @machize/subscriptions@0.8.0

## 0.7.0

### Patch Changes

- @machize/admin@0.7.0
- @machize/subscriptions@0.7.0

## 0.6.0

### Patch Changes

- @machize/admin@0.6.0
- @machize/subscriptions@0.6.0

## 0.5.1

### Patch Changes

- @machize/subscriptions@0.5.1
- @machize/admin@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [ec514e5]
  - @machize/subscriptions@0.5.0
  - @machize/admin@0.5.0

## 0.4.0

### Patch Changes

- @machize/subscriptions@0.4.0
- @machize/admin@0.4.0

## 0.3.0

### Patch Changes

- d0c1436: Make @machize/dashboard browser-safe. computeBillingMetrics no longer imports
  @machize/subscriptions at runtime (which transitively pulled @machize/fastify
  and @machize/core's top-level AsyncLocalStorage) — the subscriptions imports are
  now type-only and planPrice is inlined. Public API unchanged; the package now
  bundles cleanly into a browser admin.
  - @machize/subscriptions@0.3.0
  - @machize/admin@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Machize ecosystem — a batteries-included,
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
    travel), create-machize, sdk (typed client from Zod endpoints),
    generator (mach make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @machize/admin@0.1.0
  - @machize/subscriptions@0.1.0
