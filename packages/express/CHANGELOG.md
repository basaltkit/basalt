# @machize/express

## 0.15.0

### Patch Changes

- @machize/core@0.15.0
- @machize/http@0.15.0

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
