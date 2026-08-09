# @machize/http

## 1.0.5

### Minor Changes

- Add `RedisRateLimitStore` — a Redis-backed `RateLimitStore` so a rate limit is
  shared across every instance and survives a restart (the in-memory store is
  per-process and resets on reboot). The window is a fixed counter incremented
  atomically in one round trip (INCR + first-hit PEXPIRE), so concurrent callers
  can't overshoot. Inject any ioredis-compatible client — no new dependency.
- `RateLimitStore.hit`/`reset` may now return a promise; the security plugin
  awaits them. Existing synchronous stores are unaffected.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.24.0

### Patch Changes

- @machize/core@0.24.0

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

- 0f9dbe2: Fix `openapiPlugin` emitting an empty `paths` when registered before the HTTP adapter.

  Adapters publish the route list (`http:routes`) during their own boot phase, so building the document in `openapiPlugin`'s boot depended on plugin order — registering it before `fastifyPlugin`/`expressPlugin`/`honoPlugin` produced `{ "paths": {} }`. The document is now generated on the `app:booted` hook, after every plugin has registered its routes and before the server starts listening, so plugin order no longer matters.

  - @machize/core@0.5.1

## 0.5.0

### Patch Changes

- @machize/core@0.5.0

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

- @machize/core@0.4.0
