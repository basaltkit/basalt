# @basaltkit/core

## 1.3.0

### Minor Changes

- 8a3e92a: `HookBus.emit` now isolates handlers — one failure no longer starves the rest.
  
  Previously the first throwing handler aborted the chain: later handlers and every `onAny` observer (the audit trail, devtools) silently never ran, and the raw error propagated into the emitting domain code. `emit` now runs **every** handler and every `onAny` observer (same contract as `EventBus.emit`), then surfaces failures: a single failure rethrows the original error unchanged; several become an `AggregateError`. Nothing is swallowed — a failing hook still fails the emitter — but the audit trail can no longer have holes. Only code relying on a throwing hook *preventing subsequent handlers from running* is affected; no such usage exists in the ecosystem (verified by sweep).

## 1.2.0

### Minor Changes

- c6f661c: Fail-loud captive-dependency guard in the Container.
  
  A `singleton` factory that resolved a `scoped` token used to capture it silently: the singleton is memoized on its owning container and outlives every scope, so ONE request's scoped instance became part of an app-wide service and was served to every later request. The container now throws the new `CaptiveDependencyError` (`code: 'DI_CAPTIVE_DEPENDENCY'`, exported from the barrel) the moment a scoped token is resolved while a singleton build is in flight — naming both tokens and pointing at the fix (resolve the scoped service at use time, e.g. from `ctx().container`, not at construction).
  
  The check is O(1) and allocation-free on the hot path (an integer counter incremented per singleton build plus one compare per scoped resolution; micro-benched at no measurable cost). Legitimate graphs are untouched — singleton→singleton/transient, scoped→singleton, and a singleton deliberately managing its own `createScope()` all behave exactly as before.

## 1.1.1

### Patch Changes

- c305a67: Security hardening from a deep adversarial audit of this release's new components.

  - **dashboard (CRITICAL):** `brandingStyleSheet`/`brandingCssVars` now strictly validate custom-property names and values and drop anything that could break out of the `<style>` element — closes a tenant-controlled stored-XSS/CSS-injection vector in the white-label shell. Analytics `subscriptionMrr` uses `Number.isFinite` so `NaN`/`Infinity` prices can't poison MRR.
  - **auth:** the WebAuthn registration challenge is now bound to its subject — `finishRegistration` throws `WEBAUTHN_SUBJECT_MISMATCH` unless the `userId` matches the one `startRegistration` was called with (prevents binding a passkey to another account), rejects a duplicate credential id (`PASSKEY_EXISTS`) instead of overwriting, namespaces registration vs authentication challenges, validates the credential id type, and the in-memory challenge store now purges expired entries + caps size. **`WebAuthnChallengeStore` now stores/returns `StoredChallenge` objects** (was a bare string).
  - **tenancy:** custom-domain `verify`/`instructions`/`remove` are now tenant-scoped (`DomainForbiddenError`); a shared `normalizeDomain` (lowercase/port/trailing-dot/IDNA) is used by registration, lookup AND the Host resolver; `MemoryDomainStore.add` rejects duplicates atomically; `verify(tenantId, domain, { force })` re-checks DNS and **revokes** on failure (dangling-domain defence); new `findByVerifiedDomain` helper wires only verified domains into `TenantSource.findByDomain`.
  - **prisma:** `readReplica` gains `extend` (apply the same extension to primary AND every replica — prevents an un-scoped replica leaking all tenants) and routes `$queryRaw`/`$queryRawUnsafe` to the **primary by default** (opt back in with `rawReadsOnReplica`). `ShardRouter` defensively copies its shards.
  - **http:** SSE `encodeSseEvent` strips CR/LF/NUL from `id`/`event` (event-stream injection) and splits `data` on all line terminators; `send()` now returns a boolean backpressure signal.
  - **core:** `renderDependencyGraph` escapes token descriptions so a label can't break out of / inject HTML into the Mermaid node.

## 1.1.0

### Minor Changes

- fd5b55c: Add DI-graph devtools on the container. `container.describe()` returns a static
  snapshot of every reachable binding (token, lifetime, whether it's been built).
  `container.enableGraph()` turns on passive dependency-graph recording (off by
  default — zero overhead); `container.dependencyGraph()` then returns the
  `A depends on B` edges observed during real resolutions, and
  `renderDependencyGraph(graph)` renders it as Mermaid for docs or debugging.

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

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.0

## 0.8.1

## 0.8.0

## 0.7.0

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

### Minor Changes

- 8a0ccbc: Observability (M2):

  - `@basaltkit/core`: zero-dependency metrics primitives — `Counter`, `Gauge`, `Histogram` and a `MetricsRegistry` that renders the Prometheus text exposition format (labels, cumulative buckets, sum/count).
  - `@basaltkit/fastify`: `metricsPlugin` exposes a Prometheus `/metrics` endpoint and auto-instruments HTTP requests (`http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`), labelling by route template to keep cardinality bounded. The registry is resolvable via the `METRICS` token for app metrics.

- 7b92e25: Reliability & tracing:

  - `@basaltkit/events`: transactional **outbox** for at-least-once delivery to external systems — `Outbox`, `MemoryOutboxStore`, `outboxPlugin` (capture domain events tenant-scoped, relay on an interval with retry/backoff and a dead-letter ceiling).
  - `@basaltkit/core`: dependency-free **distributed tracing** — W3C trace-context (`parseTraceparent`/`formatTraceparent`), `Tracer`/`Span`, and an **OTLP/HTTP JSON exporter** that talks to any OpenTelemetry collector (`OtlpHttpExporter`), plus `ConsoleSpanExporter`/`InMemorySpanExporter`.
  - `@basaltkit/fastify`: `tracingPlugin` — continues an inbound trace, records a server span per request (labelled by route template) with HTTP attributes and status, echoes `traceparent`, and exports.

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
