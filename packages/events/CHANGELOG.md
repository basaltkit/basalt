# @machize/events

## 0.23.0

### Patch Changes

- @machize/core@0.23.0

## 0.22.0

### Patch Changes

- @machize/core@0.22.0

## 0.21.0

### Patch Changes

- @machize/core@0.21.0

## 0.20.0

### Patch Changes

- @machize/core@0.20.0

## 0.19.0

### Patch Changes

- @machize/core@0.19.0

## 0.18.0

### Patch Changes

- @machize/core@0.18.0

## 0.17.0

### Patch Changes

- @machize/core@0.17.0

## 0.16.0

### Patch Changes

- @machize/core@0.16.0

## 0.15.0

### Patch Changes

- @machize/core@0.15.0

## 0.14.0

### Patch Changes

- @machize/core@0.14.0

## 0.13.0

### Patch Changes

- @machize/core@0.13.0

## 0.12.0

### Patch Changes

- @machize/core@0.12.0

## 0.11.0

### Patch Changes

- @machize/core@0.11.0

## 0.10.0

### Patch Changes

- @machize/core@0.10.0

## 0.9.0

### Patch Changes

- @machize/core@0.9.0

## 0.8.1

### Patch Changes

- @machize/core@0.8.1

## 0.8.0

### Patch Changes

- @machize/core@0.8.0

## 0.7.0

### Patch Changes

- @machize/core@0.7.0

## 0.6.0

### Patch Changes

- @machize/core@0.6.0

## 0.5.1

### Patch Changes

- @machize/core@0.5.1

## 0.5.0

### Patch Changes

- @machize/core@0.5.0

## 0.4.0

### Patch Changes

- @machize/core@0.4.0

## 0.3.0

### Minor Changes

- 7b92e25: Reliability & tracing:

  - `@machize/events`: transactional **outbox** for at-least-once delivery to external systems — `Outbox`, `MemoryOutboxStore`, `outboxPlugin` (capture domain events tenant-scoped, relay on an interval with retry/backoff and a dead-letter ceiling).
  - `@machize/core`: dependency-free **distributed tracing** — W3C trace-context (`parseTraceparent`/`formatTraceparent`), `Tracer`/`Span`, and an **OTLP/HTTP JSON exporter** that talks to any OpenTelemetry collector (`OtlpHttpExporter`), plus `ConsoleSpanExporter`/`InMemorySpanExporter`.
  - `@machize/fastify`: `tracingPlugin` — continues an inbound trace, records a server span per request (labelled by route template) with HTTP attributes and status, echoes `traceparent`, and exports.

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
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
