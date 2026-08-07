# @machize/fastify

## 0.14.0

### Patch Changes

- @machize/core@0.14.0
- @machize/http@0.14.0

## 0.13.0

### Patch Changes

- @machize/core@0.13.0
- @machize/http@0.13.0

## 0.12.0

### Patch Changes

- @machize/core@0.12.0
- @machize/http@0.12.0

## 0.11.0

### Patch Changes

- @machize/core@0.11.0
- @machize/http@0.11.0

## 0.10.0

### Patch Changes

- @machize/core@0.10.0
- @machize/http@0.10.0

## 0.9.0

### Patch Changes

- @machize/core@0.9.0
- @machize/http@0.9.0

## 0.8.1

### Patch Changes

- @machize/core@0.8.1
- @machize/http@0.8.1

## 0.8.0

### Patch Changes

- @machize/core@0.8.0
- @machize/http@0.8.0

## 0.7.0

### Patch Changes

- @machize/core@0.7.0
- @machize/http@0.7.0

## 0.6.0

### Patch Changes

- @machize/core@0.6.0
- @machize/http@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [0f9dbe2]
  - @machize/http@0.5.1
  - @machize/core@0.5.1

## 0.5.0

### Patch Changes

- @machize/core@0.5.0
- @machize/http@0.5.0

## 0.4.0

### Minor Changes

- ed43e86: Framework-neutral HTTP core + Express and Hono adapters:

  - New `@machize/http` holds the framework-neutral route pipeline — `route()`, `HttpRequest`/`HttpReply`, validation, enrichers, guards, error mapping (`runRoute`, `toErrorResponse`). Write a route once and run it on any adapter.
  - `@machize/fastify` is refactored to build on `@machize/http` (it re-exports `route`/`HttpError`/`RequestEnricher`/`RouteGuard`, so existing imports keep working) — the handler's `request`/`reply` are now the neutral types.
  - New `@machize/express` and `@machize/hono` adapters run the exact same routes, enrichers and guards. Tenancy, auth, permissions, validation and error shapes are identical across all three frameworks.

- 3e26f2a: Framework-neutral edge plugins. `securityPlugin`, `healthPlugin`, `metricsPlugin`,
  `tracingPlugin` and `openapiPlugin` now target a neutral `HttpServer` (the new
  `HTTP_SERVER` token that every adapter provides), so they run unchanged on
  Fastify, Express and Hono. They moved into `@machize/http` and are re-exported
  from `@machize/fastify` for back-compat. `idempotencyPlugin` stays Fastify-specific
  (it intercepts the response body). Adapters now expose `use`/`after`/`addRoute`
  via an `HttpServerCollector` mounted after all plugins register.

### Patch Changes

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @machize/http@0.4.0
  - @machize/core@0.4.0

## 0.3.0

### Minor Changes

- 4846bc1: `idempotencyPlugin`: safe retries for mutating requests. When a client sends an
  `Idempotency-Key`, the first response is cached and replayed for repeats with
  the same key (scoped by method + route), so a network retry never performs the
  operation twice. In-flight duplicates get `409 IDEMPOTENCY_CONFLICT`; `5xx`
  responses are not cached so real failures stay retryable. Pluggable store
  (in-memory default).
- 8a0ccbc: Observability (M2):

  - `@machize/core`: zero-dependency metrics primitives — `Counter`, `Gauge`, `Histogram` and a `MetricsRegistry` that renders the Prometheus text exposition format (labels, cumulative buckets, sum/count).
  - `@machize/fastify`: `metricsPlugin` exposes a Prometheus `/metrics` endpoint and auto-instruments HTTP requests (`http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`), labelling by route template to keep cardinality bounded. The registry is resolvable via the `METRICS` token for app metrics.

- b405334: OpenAPI (M3): `openapiPlugin` serves an OpenAPI 3.0 document generated from the
  app's registered routes and their Zod schemas — no duplicate annotations. Adds
  `generateOpenApi()` and a minimal `zodToJsonSchema()` (common Zod subset →
  JSON Schema). Point Swagger UI / Redoc at `/openapi.json`.
- 7b92e25: Reliability & tracing:

  - `@machize/events`: transactional **outbox** for at-least-once delivery to external systems — `Outbox`, `MemoryOutboxStore`, `outboxPlugin` (capture domain events tenant-scoped, relay on an interval with retry/backoff and a dead-letter ceiling).
  - `@machize/core`: dependency-free **distributed tracing** — W3C trace-context (`parseTraceparent`/`formatTraceparent`), `Tracer`/`Span`, and an **OTLP/HTTP JSON exporter** that talks to any OpenTelemetry collector (`OtlpHttpExporter`), plus `ConsoleSpanExporter`/`InMemorySpanExporter`.
  - `@machize/fastify`: `tracingPlugin` — continues an inbound trace, records a server span per request (labelled by route template) with HTTP attributes and status, echoes `traceparent`, and exports.

- 94a01eb: Production hardening (M1 — secure by default):

  - `@machize/fastify`: new `securityPlugin` (rate limiting with a pluggable store, CORS with allow-listing + preflight, and secure response headers — HSTS, nosniff, frame-deny, referrer-policy, COOP), and `healthPlugin` with distinct `/livez` (liveness) and `/readyz` (readiness, runs dependency checks → 503 when any fails).
  - `@machize/env`: new `secret()` schema — fail-closed in production (required, rejects placeholder-looking values, enforces a minimum length) while keeping a `devDefault` for local runs.
  - `@machize/auth`: brute-force lockout on `login()` via `LoginThrottle` (enabled by default, per-email rolling window, cleared on success; `loginThrottle: false` to disable).

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
