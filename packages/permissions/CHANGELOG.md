# @machize/permissions

## 0.16.0

### Patch Changes

- @machize/core@0.16.0
- @machize/fastify@0.16.0

## 0.15.0

### Patch Changes

- @machize/core@0.15.0
- @machize/fastify@0.15.0

## 0.14.0

### Patch Changes

- @machize/core@0.14.0
- @machize/fastify@0.14.0

## 0.13.0

### Patch Changes

- @machize/core@0.13.0
- @machize/fastify@0.13.0

## 0.12.0

### Patch Changes

- @machize/core@0.12.0
- @machize/fastify@0.12.0

## 0.11.0

### Patch Changes

- @machize/core@0.11.0
- @machize/fastify@0.11.0

## 0.10.0

### Patch Changes

- @machize/core@0.10.0
- @machize/fastify@0.10.0

## 0.9.0

### Patch Changes

- @machize/core@0.9.0
- @machize/fastify@0.9.0

## 0.8.1

### Patch Changes

- @machize/core@0.8.1
- @machize/fastify@0.8.1

## 0.8.0

### Patch Changes

- @machize/core@0.8.0
- @machize/fastify@0.8.0

## 0.7.0

### Patch Changes

- @machize/core@0.7.0
- @machize/fastify@0.7.0

## 0.6.0

### Patch Changes

- @machize/core@0.6.0
- @machize/fastify@0.6.0

## 0.5.1

### Patch Changes

- @machize/fastify@0.5.1
- @machize/core@0.5.1

## 0.5.0

### Patch Changes

- @machize/core@0.5.0
- @machize/fastify@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @machize/fastify@0.4.0
  - @machize/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [4846bc1]
- Updated dependencies [8a0ccbc]
- Updated dependencies [b405334]
- Updated dependencies [7b92e25]
- Updated dependencies [94a01eb]
  - @machize/fastify@0.3.0
  - @machize/core@0.3.0

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
  - @machize/core@0.1.0
  - @machize/fastify@0.1.0
