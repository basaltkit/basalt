# @machize/queue

## 0.6.0

### Minor Changes

- f155979: Add driver capability checks so unsupported job options fail loudly instead of being silently dropped.

  Backends differ — a driver may not honor delayed delivery, priority, retries, or retry backoff (Kafka has no message priority, a naive RabbitMQ setup has no delayed jobs, the sync driver runs inline). A driver now declares a `capabilities` object (`{ delayed, priority, retries, backoff }`), and the `QueueManager` checks each dispatch's options against it.

  - New `DriverCapabilities` type; `QueueDriver` gains optional `name` and `capabilities`. `BullmqQueueDriver` declares full support; `SyncQueueDriver` declares `{ delayed: false, priority: false, retries: true, backoff: false }`.
  - `queuePlugin({ onUnsupported })` / `new QueueManager(driver, { onUnsupported })` chooses the reaction: `'warn'` (default — logs once per job+feature, then proceeds), `'throw'` (raise `UnsupportedJobOptionError`, recommended in production), or `'ignore'` (legacy silent behavior).
  - Back-compatible: a driver that omits `capabilities` is assumed fully capable, so existing custom drivers are unaffected. This is the seam a future `@machize/queue-rabbitmq` / `@machize/queue-kafka` driver plugs into.

### Patch Changes

- f2e8298: `queuePlugin({ jobs })` now accepts typed jobs without a cast. The option was typed `JobDefinition<never>[]`, so a job carrying payload data (`defineJob<{ ... }>`) forced a `as JobDefinition<never>` cast; it is now `JobDefinition<unknown>[]`, which accepts both typed and untyped jobs.
  - @machize/core@0.6.0
  - @machize/events@0.6.0

## 0.5.1

### Patch Changes

- @machize/core@0.5.1
- @machize/events@0.5.1

## 0.5.0

### Patch Changes

- @machize/core@0.5.0
- @machize/events@0.5.0

## 0.4.0

### Patch Changes

- @machize/core@0.4.0
- @machize/events@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @machize/core@0.3.0
  - @machize/events@0.3.0

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
  - @machize/events@0.1.0
