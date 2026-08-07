# @machize/http

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
