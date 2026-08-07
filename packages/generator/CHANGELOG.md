# @machize/generator

## 0.24.0

### Patch Changes

- @machize/cli@0.24.0

## 0.23.0

### Patch Changes

- @machize/cli@0.23.0

## 0.22.0

### Patch Changes

- @machize/cli@0.22.0

## 0.21.0

### Patch Changes

- @machize/cli@0.21.0

## 0.20.0

### Patch Changes

- @machize/cli@0.20.0

## 0.19.0

### Patch Changes

- @machize/cli@0.19.0

## 0.18.0

### Patch Changes

- @machize/cli@0.18.0

## 0.17.0

### Patch Changes

- @machize/cli@0.17.0

## 0.16.0

### Patch Changes

- @machize/cli@0.16.0

## 0.15.0

### Patch Changes

- @machize/cli@0.15.0

## 0.14.0

### Patch Changes

- @machize/cli@0.14.0

## 0.13.0

### Patch Changes

- @machize/cli@0.13.0

## 0.12.0

### Patch Changes

- @machize/cli@0.12.0

## 0.11.0

### Patch Changes

- @machize/cli@0.11.0

## 0.10.0

### Patch Changes

- @machize/cli@0.10.0

## 0.9.0

### Patch Changes

- @machize/cli@0.9.0

## 0.8.1

### Patch Changes

- @machize/cli@0.8.1

## 0.8.0

### Patch Changes

- @machize/cli@0.8.0

## 0.7.0

### Patch Changes

- @machize/cli@0.7.0

## 0.6.0

### Patch Changes

- @machize/cli@0.6.0

## 0.5.1

### Patch Changes

- @machize/cli@0.5.1

## 0.5.0

### Patch Changes

- @machize/cli@0.5.0

## 0.4.0

### Patch Changes

- @machize/cli@0.4.0

## 0.3.0

### Minor Changes

- 4846bc1: `mach make:resource --prisma` (and per-artifact `make:repository --prisma`)
  generates a Prisma-backed repository using `db<PrismaClient>()` plus a
  `.prisma` model block to paste into schema.prisma, and wires the Prisma
  repository in the generated plugin — closing the loop to real persistence
  (incl. database-per-tenant). The default stays in-memory.

### Patch Changes

- @machize/cli@0.3.0

## 0.2.0

### Minor Changes

- `mach make:resource` now auto-wires the generated resource into `src/app.ts`: it adds the plugin + routes imports, registers the plugin in the `plugins` array, and spreads the routes into `fastifyPlugin({ routes: [...] })`. The wiring is idempotent (re-running never duplicates) and best-effort — if `app.ts` is missing or does not match the expected shape, nothing is changed and manual instructions are printed. Pass `--no-register` to opt out. New exported `registerResourceInApp()` / `AppRegistration`.

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
  - @machize/cli@0.1.0
