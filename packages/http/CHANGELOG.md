# @basaltkit/http

## 1.5.0

### Minor Changes

- 90e48fe: Add the `generate:docs` CLI command.

  `openapiPlugin` now registers a `generate:docs` command that rebuilds the OpenAPI 3.0 document from the same routes/info/tags it serves and writes it to a file (`--out=<path>`, default `openapi.json`) or stdout (`--stdout`) — without starting the HTTP server. Useful for CI, publishing, and static docs pipelines. Registered structurally into the CLI command bucket (no hard `@basaltkit/cli` dependency).

## 1.4.0

### Minor Changes

- Restrictive default `Content-Security-Policy` when secure headers are enabled (overridable / `false` to omit), and per-route rate limits via `route.meta.rateLimit`.

## 1.3.0

### Minor Changes

- OpenAPI: **top-level `tags` support.** `generateOpenApi` and `openapiPlugin` now accept a `tags` list (`{ name, description }[]`) and emit a top-level `tags` array in the document, so tools like Swagger UI can order and describe the operation groups. Any tag used on an operation (`route.meta.tags`) but not described is still listed by name, so no group is dropped; when nothing is tagged, no `tags` array is emitted. Exposes the `OpenApiTag` type. Per-operation tags (from `meta.tags`) are unchanged.

## 1.2.0

### Minor Changes

- Security hardening (edge headers, CORS, rate limiting, health):
  - **CORS no longer reflects an arbitrary `Origin` when `credentials` is
    enabled.** Reflecting the request origin back _with_ `Access-Control-Allow-Credentials: true` hands authenticated, cookie-bearing responses to any site. `securityPlugin` now refuses to emit `Access-Control-Allow-Origin` in the reflect-all case when `credentials: true` — credentialed CORS requires an explicit `origin` allowlist (string, array, or predicate). Non-credentialed reflect-all (`*`) is unchanged.
  - **Rate-limit key no longer trusts `X-Forwarded-For`.** The default key used the client-spoofable `X-Forwarded-For` header, letting a caller mint an unlimited number of buckets and bypass the limit. It now uses the socket address the adapter sets on `request.ip`, falling back to a single shared bucket (fail closed) when unknown. Behind a trusted proxy, configure the adapter to populate `request.ip`; pass a custom `key` to opt back into header-derived keys deliberately.
  - **`/readyz` no longer leaks raw error text.** A failing readiness check returned the thrown error's message to an unauthenticated probe, exposing DB hosts/ports/DSN fragments. The client body now reports only `{ ok: false }` per check; the cause is logged server-side via `console.error`.

## 1.1.0

### Minor Changes

- `generateOpenApi` now renders `summary`, `description`, `tags` and `operationId` from `route.meta`, and gives each response a human status description (201 → Created, 204 → No Content, 404 → Not Found, …) instead of a flat "OK".

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

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- 0f9dbe2: Fix `openapiPlugin` emitting an empty `paths` when registered before the HTTP adapter.

  Adapters publish the route list (`http:routes`) during their own boot phase, so building the document in `openapiPlugin`'s boot depended on plugin order — registering it before `fastifyPlugin`/`expressPlugin`/`honoPlugin` produced `{ "paths": {} }`. The document is now generated on the `app:booted` hook, after every plugin has registered its routes and before the server starts listening, so plugin order no longer matters.

  - @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0

## 0.4.0

### Minor Changes

- ed43e86: Framework-neutral HTTP core + Express and Hono adapters:

  - New `@basaltkit/http` holds the framework-neutral route pipeline — `route()`, `HttpRequest`/`HttpReply`, validation, enrichers, guards, error mapping (`runRoute`, `toErrorResponse`). Write a route once and run it on any adapter.
  - `@basaltkit/fastify` is refactored to build on `@basaltkit/http` (it re-exports `route`/`HttpError`/`RequestEnricher`/`RouteGuard`, so existing imports keep working) — the handler's `request`/`reply` are now the neutral types.
  - New `@basaltkit/express` and `@basaltkit/hono` adapters run the exact same routes, enrichers and guards. Tenancy, auth, permissions, validation and error shapes are identical across all three frameworks.

- 3e26f2a: Framework-neutral edge plugins. `securityPlugin`, `healthPlugin`, `metricsPlugin`,
  `tracingPlugin` and `openapiPlugin` now target a neutral `HttpServer` (the new
  `HTTP_SERVER` token that every adapter provides), so they run unchanged on
  Fastify, Express and Hono. They moved into `@basaltkit/http` and are re-exported
  from `@basaltkit/fastify` for back-compat. `idempotencyPlugin` stays Fastify-specific
  (it intercepts the response body). Adapters now expose `use`/`after`/`addRoute`
  via an `HttpServerCollector` mounted after all plugins register.

### Patch Changes

- @basaltkit/core@0.4.0
