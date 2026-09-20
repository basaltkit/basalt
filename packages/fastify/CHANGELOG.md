# @basaltkit/fastify

## 2.3.0

### Minor Changes

- 6d446ef: Streaming responses: a handler can return a stream, on every adapter (BK-019, last open item).
  
  `@basaltkit/storage` learned to stream in both directions and `files.downloadStream()` followed, but the framework had nowhere to put the result: a handler could only return a value the adapter serialised, so `fileRoutes` still served downloads through the buffered `files.download()` and a route could not pipe a request body straight into storage. **`stream()`** closes that gap — the neutral streaming response, next to `sse()`.
  
  - **`stream(source, { contentType?, contentLength?, filename?, disposition?, headers?, status? })`** (new, `@basaltkit/http`). `source` is a Node `Readable`, a web `ReadableStream`, or any `AsyncIterable<Uint8Array>`. Fastify hands it to its own stream path, Express uses `pipeline()`, Hono answers with a `Response` over a web stream — none of them buffers it. `filename` goes through the same `sanitizeFilename()` the multipart parser uses and is written as a quoted printable-ASCII `filename=` plus an RFC 5987 `filename*=UTF-8''…` when anything was lost, so a client-supplied name can never inject a header; the disposition defaults to `attachment`, because an uploaded HTML or SVG must never render on your origin.
  - **The robustness is the feature, and it is identical on all three.** A client that disconnects mid-download **destroys the source** — no leaked file descriptor, no leaked S3 socket. Backpressure is real: a slow client slows the read instead of filling memory. An error **before** the first byte is still a normal JSON error response (the streaming headers are withdrawn first, so the envelope does not inherit the download's `Content-Type`/`Content-Disposition`). An error **after** the headers cuts the connection rather than appending anything to a partly sent body, and is reported **once** through the adapter's `onError` reporter (`STREAM_FAILED`, status 500) instead of being swallowed or double-counted. `HEAD` sends no body, keeps the headers a `GET` would have carried, and reads nothing from the source — on Fastify that means bypassing its auto-generated HEAD route, which would otherwise drain the whole source to discard it and answer `content-length: 0`. All of it is held to one shared parity suite the three adapters run, including a multi-MiB body compared byte for byte.
  - There is deliberately **no `maxDurationMs`** (unlike `sse()`): a large download legitimately takes a long time and a framework-level cap would truncate it. The adapters' own server timeouts are documented instead.
  - `meta: { etag: true }` now skips a streamed (or SSE) result — hashing the marker object would have answered `304` for a body that was never sent.
  - **`fileRoutes()` gains `GET /files/:id/content`**, streamed with `files.downloadStream()` and falling back to the buffered read only on a driver with no `getStream` (`files.canStreamDownloads()` is new, and public). It keeps every existing rule: object-level authorization (a new `'download'` action, alongside `'read' | 'url' | 'delete'`), the quarantine gate (423/403) and the 404-for-unreachable, all of which close **before the first byte**. `fileRoutes({ download: false })` leaves it out.
  - **`fileRoutes({ upload: { maxBytes, maxFiles?, allowedTypes? } })`** mounts `POST /files` — **opt-in, off by default** — a streamed multipart upload straight into storage with `uploadedBy` set to the caller and the same tenant scoping, validation and quota rules as `files.upload()`.
  - **Uploading straight into storage** now works end to end: `UploadedFile.declaredLength` exposes the part's **own** `Content-Length` when the client sent one, so it can be passed to `files.upload(stream, { contentLength })` and a backend that needs an exact size (S3) streams instead of buffering. The docs say plainly that this is usually absent — RFC 7578 does not require a per-part `Content-Length` and no browser sends one — and that the request's `Content-Length` (also exposed, as `UploadBody.contentLength`) covers every part plus the framing, so it is an upper bound for one file and never its size. Without a declared length the write is bounded by `validate.maxSize`, as before.
  
  No existing API changes. `'download'` is a new value a custom `fileRoutes({ authorize })` will now be asked about; a policy that switches exhaustively on `action` denies it, which fails closed.

### Patch Changes

- Updated dependencies [6d446ef]
  - @basaltkit/http@2.4.0

## 2.2.0

### Minor Changes

- b0cc59f: Adapter-neutral streaming uploads and per-user/tenant rate limits.
  
  - **`upload()` route body (BK-006).** `route({ body: upload({ maxBytes, maxFiles, maxFileBytes?, maxFields?, maxFieldBytes?, maxHeaderBytes?, allowedTypes? }) })` accepts `multipart/form-data` on Fastify, Express and Hono. The handler receives `{ files: AsyncIterable<{ field, filename, declaredType, stream }>, fields }`. `@basaltkit/http` parses the body with its own streaming RFC 7578 parser, which has no dependencies and never buffers the body. The full pipeline (pre-hooks, enrichers, guards: rate limit, tenant, auth) runs before a single body byte is read.
    - Every limit is enforced on the bytes actually received: `413 PAYLOAD_TOO_LARGE` (a larger declared `Content-Length` is refused up front), `400 TOO_MANY_FILES` / `TOO_MANY_FIELDS`, `415 UNSUPPORTED_MEDIA_TYPE`, and `400 MALFORMED_MULTIPART` for a bad or repeated boundary, a truncated body, oversized or folded part headers, or a nested multipart part.
    - Filenames are sanitised (`sanitizeFilename`): directories, drive letters, control/NUL and bidi characters are stripped.
    - An upload the handler leaves unread is drained (up to `maxBytes`) with `Connection: close`, so nothing hangs.
    - OpenAPI documents the body as `multipart/form-data`.
    - New exports: `upload`, `isUploadBody`, `uploadOptionsOf`, `sanitizeFilename`, and the types `UploadOptions`, `UploadBody`, `UploadedFile`. `HttpRequest` gains an optional `bodyStream`.
    - Per adapter:
      - Fastify registers a pass-through multipart parser, only when an upload route exists and never over one you registered yourself. Other routes still answer 415.
      - Express hands the untouched `req` stream to the parser.
      - Hono streams `c.req.raw.body`. Pre-hooks and after-hooks no longer read multipart bodies, and a non-upload route still parses them within `bodyLimit`.
  - **`meta.rateLimit.key` (BK-008).** A per-route bucket can now belong to `'ip'` (default, unchanged), `'user'` (`ctx().user.id`), `'tenant'` (`ctx().tenant.id`), `'user+tenant'`, or a function of `ctx()`. The key is resolved in the route guard after enrichers ran. When there is no user or tenant it falls back to the client IP. It uses the same memory or Redis store. New type: `RateLimitKey`.
  - `meta.mfa` joins the guarded route-meta keys: a route declaring `mfa: true` refuses to boot unless `authPlugin` (which now claims it) is registered.

### Patch Changes

- Updated dependencies [b0cc59f]
- Updated dependencies [b0cc59f]
  - @basaltkit/core@1.3.2
  - @basaltkit/http@2.2.0

## 2.1.0

### Minor Changes

- fb85c40: Security: `idempotencyPlugin` now scopes cached responses by all caller credential headers (`authorization`, `x-session-id`, `cookie`, `x-api-key`, configurable via `credentialHeaders`) plus tenant (`x-tenant-id`, `host`), hashes the scoped key with SHA-256, and no longer caches or replays requests without credentials unless `allowAnonymous: true` — previously a cached response could be replayed to a different or unauthenticated caller. Idempotency keys longer than 255 characters are rejected with `400 IDEMPOTENCY_KEY_INVALID`, and `MemoryIdempotencyStore` now sweeps expired entries and is capped by `maxEntries` (default 10 000).
  
  Only the request that owns the reservation records or releases the outcome: a concurrent `409 IDEMPOTENCY_CONFLICT` can no longer overwrite the in-flight reservation.

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/http@2.1.0

## 2.0.0

### Major Changes

- d5ca076: **Zod 3 is no longer supported.** These packages now require zod 4.
  
  The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
  change for any application still on zod 3: the install will refuse the peer
  rather than fail somewhere subtle at runtime, which is the point of declaring it.
  
  The move itself was overdue — the repository has been testing against zod 4 only
  for some time, through a workspace override, so the second half of that range was
  a claim nobody was checking. Supporting a major version you never run is worse
  than not supporting it: it holds back the API surface (a schema written against
  zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
  compatibility that would break on first contact.
  
  **Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
  migration guide covers the API changes; the ones that touch Basalt users most are
  `z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
  moving from `message`/`invalid_type_error` to a single `error` parameter.
  
  The peer asks for `^4.0.0` and not the version this repo happens to test —
  requiring the newest 4.x would force every consumer to move in step with us for
  no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
  so its range narrowing is not breaking for anyone.
  
  **The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
  `switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
  `z.toJSONSchema` does natively — reachable only when the native converter was
  absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
  `_def` for every introspection. Both are gone, along with the coverage test
  that existed solely to drive the dead path by mocking zod's converter away.
  
  `create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
  generated after this change would have failed its own install against the new
  peer; it now scaffolds `^4.0.0`.

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0

## 1.9.0

### Minor Changes

- 94e5073: **Failed requests are now reported on every adapter, at every status.**
  
  Whether an error was visible used to depend on which adapter you had mounted —
  exactly the difference the neutral pipeline exists to erase:
  
  | | before | now |
  | --- | --- | --- |
  | `@basaltkit/fastify` | 5xx only, and only from one of its **two** catch sites | every 4xx/5xx, both sites |
  | `@basaltkit/express` | **nothing at all** — a 500 left no server trace | every 4xx/5xx |
  | `@basaltkit/hono` | **nothing at all** — a 500 left no server trace | every 4xx/5xx |
  
  Client errors were silent everywhere. That is defensible for a 404 from a
  scanner, and useless when you are trying to work out why your own request came
  back 400 and the terminal is empty.
  
  ### The policy
  
  5xx go to `error` **with the error object**, so the stack survives — it is a bug.
  4xx go to `warn` as a single line with the code and message; a validation
  failure's stack is noise.
  
  It lives in `@basaltkit/http` (`reportHttpError`, `httpErrorReporter`,
  `HttpErrorReport`, `HttpErrorReporter`, `HttpLogSink`), so the three adapters
  cannot drift apart. Each adapter's suite asserts the same behaviour.
  
  ### Structured by design, not sanitised after the fact
  
  Method, URL and the error message all come from the request. Interpolating them
  into one string raised two real issues, both flagged by CodeQL:
  
  - **Format-string injection** (high). `console` and pino treat the first argument
    as a printf format string. A URL containing `%s` made the logger consume the
    *next* argument — the error object, whose stack is the whole reason a 5xx is
    logged — as a substitution.
  - **Log forging** (medium). A newline in the URL ended the line and started
    another, letting a request write a convincing fake entry.
  
  The sink is therefore called as `(fields, message)` — pino's own signature —
  with `message` always a literal and request data confined to `fields`. Both
  classes are removed rather than escaped: a value that never reaches the format
  position cannot be interpreted, and pino (JSON) and the console
  (`util.inspect`) both quote it when serialising.
  
  `consoleSink` is exported and adapts the console to that contract, flipping the
  argument order so the message still reads first in a terminal.
  
  An escaping-based version was tried first. It was correct and tested, but static
  analysis cannot recognise a custom sanitiser, so the alert never cleared. Passing
  the values as printf arguments was tried too, and is worse than it looks: pino
  **silently drops arguments beyond the placeholders**, so the stack would have
  been thrown away.
  
  ### Overriding it
  
  `fastifyPlugin`, `expressPlugin` and `honoPlugin` all accept `onError`:
  
  ```ts
  fastifyPlugin({
    routes,
    onError: ({ error, status, code, method, url }) =>
      logger.error({ err: error, status, code, method, url }, 'request failed'),
  })
  ```
  
  Pass `() => {}` to silence them.
  
  ### Where the default writes
  
  Fastify uses its own logger, so records stay structured for apps that configured
  pino — **and the console for apps that did not**. A server built with
  `logger: false` (Fastify's default, and what `create-basalt` scaffolds) installs
  a no-op logger, so writing there would have discarded the report and left
  "observable by default" true only for apps that least needed it. Express and
  Hono use the console.
  
  Note that Fastify's logger and `@basaltkit/logger` are separate systems: a level
  set on `loggerPlugin` does not affect what the adapter reports.
  
  The response body is unchanged — `toErrorResponse` still decides what the client
  sees, and a 500 still says only `Internal server error.`
  
  `registerRoutes` gains an optional trailing `onError` parameter on all three
  adapters; existing calls are unaffected.

### Patch Changes

- Updated dependencies [94e5073]
  - @basaltkit/http@1.15.0

## 1.8.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1

## 1.8.0

### Minor Changes

- a76d591: **Advisory — boot now fails loud when a route declares security meta (`auth`, `can`, `teamRole`) that no registered guard enforces.**
  
  Previously such a route silently served **unprotected**: `meta: { auth: true }` is inert metadata until `authPlugin` registers the guard that reads it, and nothing warned when it was missing. The adapter now calls `assertRoutesGuarded` (from `@basaltkit/http`) before registering routes and refuses to boot, listing every offending route and the plugin that enforces each key.
  
  **If your app fails to boot after upgrading:** register the enforcing plugin (`auth` → `authPlugin`, `can` → `permissionsPlugin`, `teamRole` → `teamsPlugin`) — or, if protection genuinely happens at an outer edge/gateway, opt out explicitly with the new plugin option `allowUnguardedMeta: true` (or `['auth', …]` for specific keys). The default flips from silently-open to fail-loud on purpose: every app this breaks was serving routes it believed were protected.

### Patch Changes

- Updated dependencies [a76d591]
  - @basaltkit/http@1.12.0

## 1.7.0

### Minor Changes

- edb7eef: Neutral JSON 404 for unmatched routes — identical across all adapters.
  
  Unknown routes previously fell through to each framework's default (Fastify's own JSON shape, Express's HTML page, Hono's plain text) — the one divergent surface in the otherwise-uniform `{ error: { code, message } }` contract, and a framework fingerprint. All three adapters now serve the shared `NOT_FOUND_RESPONSE` (new export from `@basaltkit/http`): `404` `{ "error": { "code": "NOT_FOUND", "message": "Route not found." } }`, verified byte-identical by the cross-adapter conformance suite.
  
  Opt out per adapter with `notFound: false`. Overrides: on Fastify a `setNotFoundHandler` registered during a plugin's boot phase wins (the adapter's set is guarded; registering one after `app:booted` requires `notFound: false` — Fastify allows a single handler); on Hono a later `notFound()` call replaces it (last wins); on Express pass `notFound: false` and mount your own catch-all.

### Patch Changes

- Updated dependencies [edb7eef]
  - @basaltkit/http@1.10.0

## 1.6.0

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

### Patch Changes

- Updated dependencies [2c667ff]
  - @basaltkit/http@1.9.0

## 1.5.0

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
- Updated dependencies [cc2168a]
  - @basaltkit/core@1.1.0
  - @basaltkit/http@1.7.0

## 1.4.0

### Minor Changes

- 2fb6c59: **SAML 2.0 SSO** + cross-adapter form-body support.

  - New **`@basaltkit/auth-saml`** package: SP-initiated SAML 2.0 login built on the vetted `@node-saml/node-saml` XML-DSig library (no hand-rolled crypto), plugging validated assertions into `Auth.socialLogin`. `samlPlugin({ providers })` + `samlRoutes()` add `/auth/saml/:provider/login`, `…/acs` and `…/metadata`. Adapter-agnostic.
  - **Fastify and Express adapters now parse `application/x-www-form-urlencoded`** into the request body (Hono already did), so the SAML ACS POST — and HTML form submissions in general — work on any adapter.

### Patch Changes

- Updated dependencies [90e48fe]
  - @basaltkit/http@1.5.0

## 1.3.0

### Minor Changes

- Make idempotency-key reservation atomic (Redis `SET … NX PX`; reserve-then-fallback-to-read), preventing concurrent double-execution.

## 1.2.0

### Minor Changes

- Re-exports the `OpenApiTag` type and passes through the new `tags` option on `openapiPlugin` (top-level OpenAPI tag groups with descriptions — see `@basaltkit/http` 1.3.0).

## 1.1.0

### Minor Changes

- Security: **idempotency keys are now scoped to the caller.** The `Idempotency-Key` cache key was scoped only by method + route, so the same key sent by two different callers would replay the _first_ caller's cached response to the second — a cross-user/tenant data leak. The key now includes a short, non-reversible fingerprint (sha256, truncated) of the caller's `Authorization`/`x-session-id` header (or `anon`), so a key can only ever replay its own principal's response. No API change; existing keys simply gain a principal prefix.

## 1.0.5

### Minor Changes

- Add `RedisIdempotencyStore` — a Redis-backed `IdempotencyStore` so a cached
  response is replayed across every instance and the reservation survives a
  restart (the in-memory store is per-process and lost on reboot). Records carry
  a PX TTL; inject any ioredis-compatible client — no new dependency.
- `IdempotencyStore` methods may now return a promise; the idempotency plugin
  awaits them. Existing synchronous stores are unaffected.

## 1.0.3

### Patch Changes

- Fix a 500 (`INTERNAL_ERROR`) on a POST with `content-type: application/json` and an empty body — the default JSON parser threw on the empty payload, which broke bodiless endpoints (e.g. MFA enroll) called from a client that always sends a JSON content-type. Empty bodies now parse as `undefined`; malformed JSON still errors.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0
- @basaltkit/http@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/http@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/http@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/http@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/http@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/http@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/http@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/http@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/http@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/http@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/http@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/http@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/http@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/http@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/http@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/http@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/http@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/http@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/http@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/http@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [0f9dbe2]
  - @basaltkit/http@0.5.1
  - @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/http@0.5.0

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

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @basaltkit/http@0.4.0
  - @basaltkit/core@0.4.0

## 0.3.0

### Minor Changes

- 4846bc1: `idempotencyPlugin`: safe retries for mutating requests. When a client sends an
  `Idempotency-Key`, the first response is cached and replayed for repeats with
  the same key (scoped by method + route), so a network retry never performs the
  operation twice. In-flight duplicates get `409 IDEMPOTENCY_CONFLICT`; `5xx`
  responses are not cached so real failures stay retryable. Pluggable store
  (in-memory default).
- 8a0ccbc: Observability (M2):

  - `@basaltkit/core`: zero-dependency metrics primitives — `Counter`, `Gauge`, `Histogram` and a `MetricsRegistry` that renders the Prometheus text exposition format (labels, cumulative buckets, sum/count).
  - `@basaltkit/fastify`: `metricsPlugin` exposes a Prometheus `/metrics` endpoint and auto-instruments HTTP requests (`http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`), labelling by route template to keep cardinality bounded. The registry is resolvable via the `METRICS` token for app metrics.

- b405334: OpenAPI (M3): `openapiPlugin` serves an OpenAPI 3.0 document generated from the
  app's registered routes and their Zod schemas — no duplicate annotations. Adds
  `generateOpenApi()` and a minimal `zodToJsonSchema()` (common Zod subset →
  JSON Schema). Point Swagger UI / Redoc at `/openapi.json`.
- 7b92e25: Reliability & tracing:

  - `@basaltkit/events`: transactional **outbox** for at-least-once delivery to external systems — `Outbox`, `MemoryOutboxStore`, `outboxPlugin` (capture domain events tenant-scoped, relay on an interval with retry/backoff and a dead-letter ceiling).
  - `@basaltkit/core`: dependency-free **distributed tracing** — W3C trace-context (`parseTraceparent`/`formatTraceparent`), `Tracer`/`Span`, and an **OTLP/HTTP JSON exporter** that talks to any OpenTelemetry collector (`OtlpHttpExporter`), plus `ConsoleSpanExporter`/`InMemorySpanExporter`.
  - `@basaltkit/fastify`: `tracingPlugin` — continues an inbound trace, records a server span per request (labelled by route template) with HTTP attributes and status, echoes `traceparent`, and exports.

- 94a01eb: Production hardening (M1 — secure by default):

  - `@basaltkit/fastify`: new `securityPlugin` (rate limiting with a pluggable store, CORS with allow-listing + preflight, and secure response headers — HSTS, nosniff, frame-deny, referrer-policy, COOP), and `healthPlugin` with distinct `/livez` (liveness) and `/readyz` (readiness, runs dependency checks → 503 when any fails).
  - `@basaltkit/env`: new `secret()` schema — fail-closed in production (required, rejects placeholder-looking values, enforces a minimum length) while keeping a `devDefault` for local runs.
  - `@basaltkit/auth`: brute-force lockout on `login()` via `LoginThrottle` (enabled by default, per-email rolling window, cleared on success; `loginThrottle: false` to disable).

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0

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

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
