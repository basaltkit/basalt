# @basaltkit/express

## 1.8.0

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

## 1.7.0

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

## 1.6.0

### Minor Changes

- fb85c40: Security hardening for the Express and Hono adapters.
  
  - `@basaltkit/hono`: `request.ip` is now populated from the socket address (`@hono/node-server`, Bun) or a new `getClientIp` option, so per-client rate limiting and the IP login throttle work; a one-time warning is printed when no IP can be resolved.
  - `@basaltkit/hono`: `bodyLimit` is now enforced on the bytes actually read, including chunked/streamed bodies without `Content-Length`.
  - `@basaltkit/hono`: error responses keep the security and CORS headers set by pre-hooks; the 413 body now uses the standard `{ error: { code, message } }` envelope (was a flat `{ code, message }`).
  - `@basaltkit/express`: a final error middleware (opt out with `errorHandler: false`) answers body-parser and pre-hook errors with the neutral JSON envelope instead of an HTML stack trace; async pre-hook and edge-route errors are forwarded on Express 4.
  - Peer floors raised to versions without known advisories: `express ^4.22.3 || ^5.2.1`, `hono ^4.13.5`, `nodemailer ^9.1.1 || ^10.0.0`.

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/http@2.1.0

## 1.5.1

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0

## 1.5.0

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

## 1.4.1

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

## 1.4.0

### Minor Changes

- a76d591: **Advisory — boot now fails loud when a route declares security meta (`auth`, `can`, `teamRole`) that no registered guard enforces.**
  
  Previously such a route silently served **unprotected**: `meta: { auth: true }` is inert metadata until `authPlugin` registers the guard that reads it, and nothing warned when it was missing. The adapter now calls `assertRoutesGuarded` (from `@basaltkit/http`) before registering routes and refuses to boot, listing every offending route and the plugin that enforces each key.
  
  **If your app fails to boot after upgrading:** register the enforcing plugin (`auth` → `authPlugin`, `can` → `permissionsPlugin`, `teamRole` → `teamsPlugin`) — or, if protection genuinely happens at an outer edge/gateway, opt out explicitly with the new plugin option `allowUnguardedMeta: true` (or `['auth', …]` for specific keys). The default flips from silently-open to fail-loud on purpose: every app this breaks was serving routes it believed were protected.

### Patch Changes

- Updated dependencies [a76d591]
  - @basaltkit/http@1.12.0

## 1.3.0

### Minor Changes

- edb7eef: Neutral JSON 404 for unmatched routes — identical across all adapters.
  
  Unknown routes previously fell through to each framework's default (Fastify's own JSON shape, Express's HTML page, Hono's plain text) — the one divergent surface in the otherwise-uniform `{ error: { code, message } }` contract, and a framework fingerprint. All three adapters now serve the shared `NOT_FOUND_RESPONSE` (new export from `@basaltkit/http`): `404` `{ "error": { "code": "NOT_FOUND", "message": "Route not found." } }`, verified byte-identical by the cross-adapter conformance suite.
  
  Opt out per adapter with `notFound: false`. Overrides: on Fastify a `setNotFoundHandler` registered during a plugin's boot phase wins (the adapter's set is guarded; registering one after `app:booted` requires `notFound: false` — Fastify allows a single handler); on Hono a later `notFound()` call replaces it (last wins); on Express pass `notFound: false` and mount your own catch-all.

### Patch Changes

- Updated dependencies [edb7eef]
  - @basaltkit/http@1.10.0

## 1.2.0

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

## 1.1.0

### Minor Changes

- 2fb6c59: **SAML 2.0 SSO** + cross-adapter form-body support.

  - New **`@basaltkit/auth-saml`** package: SP-initiated SAML 2.0 login built on the vetted `@node-saml/node-saml` XML-DSig library (no hand-rolled crypto), plugging validated assertions into `Auth.socialLogin`. `samlPlugin({ providers })` + `samlRoutes()` add `/auth/saml/:provider/login`, `…/acs` and `…/metadata`. Adapter-agnostic.
  - **Fastify and Express adapters now parse `application/x-www-form-urlencoded`** into the request body (Hono already did), so the SAML ACS POST — and HTML form submissions in general — work on any adapter.

### Patch Changes

- Updated dependencies [90e48fe]
  - @basaltkit/http@1.5.0

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
