# @basaltkit/http

## 1.11.0

### Minor Changes

- cc4786e: **New server-rendered-HTML primitives: `escapeHtml`, `scriptJson`, `pageCsp`/`cspHash` (S-5).** One canonical escaping charset (`& < > " '`, safe in text nodes and single- or double-quoted attributes), a `</script>`-breakout-safe JSON embedder (escapes `<` plus U+2028/U+2029), and a route-scoped CSP builder that allows a page's inline script only by its sha256 hash. These back the `*-ui` packages' hardening and are exported for any app route that returns HTML.

## 1.10.0

### Minor Changes

- edb7eef: Neutral JSON 404 for unmatched routes — identical across all adapters.
  
  Unknown routes previously fell through to each framework's default (Fastify's own JSON shape, Express's HTML page, Hono's plain text) — the one divergent surface in the otherwise-uniform `{ error: { code, message } }` contract, and a framework fingerprint. All three adapters now serve the shared `NOT_FOUND_RESPONSE` (new export from `@basaltkit/http`): `404` `{ "error": { "code": "NOT_FOUND", "message": "Route not found." } }`, verified byte-identical by the cross-adapter conformance suite.
  
  Opt out per adapter with `notFound: false`. Overrides: on Fastify a `setNotFoundHandler` registered during a plugin's boot phase wins (the adapter's set is guarded; registering one after `app:booted` requires `notFound: false` — Fastify allows a single handler); on Hono a later `notFound()` call replaces it (last wins); on Express pass `notFound: false` and mount your own catch-all.

## 1.9.0

### Minor Changes

- 2c667ff: Edge hardening (security P1):

  - **`@basaltkit/fastify`** now defaults `requestTimeout` to **30s** (Fastify's own
    default is disabled), closing a slowloris hole. A caller-supplied
    `fastify.requestTimeout` still wins.
  - **`@basaltkit/http`** SSE gains `sse(producer, { heartbeatMs, maxDurationMs })`:
    a comment-ping heartbeat that keeps proxies from dropping idle streams and
    surfaces dead sockets, plus a hard lifetime cap for connections that never
    disconnect. Both off unless set; timers `unref` so they never hold the process open.

  New docs: "Resource limits & DoS resistance" (EN+PT) covering request timeouts across
  all adapters, SSE limits + backpressure, ceremony-endpoint throttling, and scheduled
  custom-domain re-verification.

## 1.8.0

### Minor Changes

- c305a67: Security hardening from a deep adversarial audit of this release's new components.

  - **dashboard (CRITICAL):** `brandingStyleSheet`/`brandingCssVars` now strictly validate custom-property names and values and drop anything that could break out of the `<style>` element — closes a tenant-controlled stored-XSS/CSS-injection vector in the white-label shell. Analytics `subscriptionMrr` uses `Number.isFinite` so `NaN`/`Infinity` prices can't poison MRR.
  - **auth:** the WebAuthn registration challenge is now bound to its subject — `finishRegistration` throws `WEBAUTHN_SUBJECT_MISMATCH` unless the `userId` matches the one `startRegistration` was called with (prevents binding a passkey to another account), rejects a duplicate credential id (`PASSKEY_EXISTS`) instead of overwriting, namespaces registration vs authentication challenges, validates the credential id type, and the in-memory challenge store now purges expired entries + caps size. **`WebAuthnChallengeStore` now stores/returns `StoredChallenge` objects** (was a bare string).
  - **tenancy:** custom-domain `verify`/`instructions`/`remove` are now tenant-scoped (`DomainForbiddenError`); a shared `normalizeDomain` (lowercase/port/trailing-dot/IDNA) is used by registration, lookup AND the Host resolver; `MemoryDomainStore.add` rejects duplicates atomically; `verify(tenantId, domain, { force })` re-checks DNS and **revokes** on failure (dangling-domain defence); new `findByVerifiedDomain` helper wires only verified domains into `TenantSource.findByDomain`.
  - **prisma:** `readReplica` gains `extend` (apply the same extension to primary AND every replica — prevents an un-scoped replica leaking all tenants) and routes `$queryRaw`/`$queryRawUnsafe` to the **primary by default** (opt back in with `rawReadsOnReplica`). `ShardRouter` defensively copies its shards.
  - **http:** SSE `encodeSseEvent` strips CR/LF/NUL from `id`/`event` (event-stream injection) and splits `data` on all line terminators; `send()` now returns a boolean backpressure signal.
  - **core:** `renderDependencyGraph` escapes token descriptions so a label can't break out of / inject HTML into the Mermaid node.

### Patch Changes

- Updated dependencies [c305a67]
  - @basaltkit/core@1.1.1

## 1.7.0

### Minor Changes

- cc2168a: Add typed Server-Sent Events, adapter-agnostic. A handler returns
  `sse(async (stream) => { stream.send(event); … })`; the core encodes the
  `text/event-stream` frames and each adapter renders it against its transport
  (a Node response on Fastify/Express, a `ReadableStream` on Hono). `stream.send`
  (object → JSON, string → data), `close()`, `closed` and `onClose()` (client
  disconnect) work identically everywhere. Exposes `sse`, `isSseResponse`,
  `encodeSseEvent`, `driveSse`, `SSE_HEADERS`.

### Patch Changes

- Updated dependencies [fd5b55c]
  - @basaltkit/core@1.1.0

## 1.6.0

### Minor Changes

- 0768769: Add conditional requests via ETags. Opt a route in with `meta: { etag: true }`:
  the shared pipeline hashes the GET/HEAD response body into a strong `ETag`, and
  when the client's `If-None-Match` matches it replies `304 Not Modified` with no
  body — adapter-agnostic (fastify/express/hono), no handler changes. Exposes
  `computeEtag` and `ifNoneMatchSatisfied`.

## 1.5.1

### Patch Changes

- d41d1c7: Support Zod 4 in `zodToJsonSchema` (used by OpenAPI and MCP input schemas). Zod 4
  removed the v3 internals the hand-rolled converter relied on (`_def.typeName`),
  so schemas produced empty `{}`. It now delegates to Zod 4's native
  `z.toJSONSchema` when present and keeps the v3 path as a fallback.

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
