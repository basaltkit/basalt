# @basaltkit/http

## 2.4.0

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

## 2.3.0

### Minor Changes

- 7363b76: Structured error details — a machine-readable payload on HTTP errors (BK-021).
  
  An error body was `{ error: { code, message } }`, so any data the UI had to act on (which checks failed, how much quota is left, the conflicting field, the current version behind a 409) had to be smuggled into the human-readable message — apps ended up parsing `Checks failed: A, B`.
  
  - **http** — `new HttpError(status, code, message, options?)` takes `HttpErrorOptions` = `{ details?: Record<string, unknown>; cause?: unknown }`. An options object rather than a fourth positional argument, so later additions do not keep widening the signature; the three-argument form is unchanged and adds no `details` key. `toErrorResponse` serializes a sanitised copy as `error.details`, so **fastify, express and hono serve the identical body** (covered by a new `errorDetailsParitySuite` the three adapter packages run).
  - **core** — `BasaltError`'s third argument is now `BasaltErrorOptions` (`ErrorOptions` + `details`), and instances expose `error.details`. Domain packages that throw a `BasaltError` with a numeric `status` (auth, permissions, files, …) can therefore carry details too, and the HTTP serializer picks them up from both. Core never sanitises: it keeps the object exactly as given.
  - **Security rules (documented in the http README, `@basaltkit/core`'s Errors section and the Core concepts guide).** `details` reaches the client verbatim, so the neutral serializer bounds it via the exported `sanitizeErrorDetails` (+ `MAX_ERROR_DETAILS_BYTES` = 4096, `MAX_ERROR_DETAILS_DEPTH` = 8): plain JSON data only (a `Date` becomes its ISO string); functions, symbols, `undefined`, BigInt, `NaN`/`Infinity`, `Error`s, `Map`/`Set`/`RegExp`, typed arrays and class instances are stripped rather than rejected (a serialisation slip must not turn a handled 422 into a 500); a dropped array element becomes `null`; a `__proto__` key is never copied; cycles and nesting past the depth cap are dropped; and a payload over 4 KiB of serialised JSON is dropped **whole**, so an error can never become an exfiltration or amplification channel. Only errors explicitly constructed with `details` ever have any — an unexpected exception is still the neutral `500 INTERNAL_ERROR` with nothing attached, and a framework-raised 4xx never grows one. Never put secrets or internals in it.
  - The `RequestValidationError` body is untouched: still exactly `{ code, message, part, issues }`, with no `details` key.
  - **sdk** — `BasaltClientError.errorDetails` returns the server's `error.details` (or `undefined`), instead of making callers dig through `error.details.error.details`; new exported `BasaltErrorBody` type for the full body shape.

### Patch Changes

- Updated dependencies [7363b76]
  - @basaltkit/core@1.4.0

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
  - @basaltkit/core@1.3.2

## 2.1.0

### Minor Changes

- fb85c40: Security hardening (B11-http):
  
  - `securityPlugin` now sends `Cache-Control: no-store` by default so responses carrying tokens, API keys or MFA secrets are not cached (`headers.cacheControl` to change it or `false` to omit; a route's own header still wins).
  - Per-route `meta.rateLimit` is now enforced by a route guard, so it holds on Express and Hono (where it was silently ignored) and for routes invoked as MCP tools, not only on Fastify.
  - `MemoryRateLimitStore` sweeps expired buckets and caps live ones (`maxEntries`, default 100 000, oldest evicted first) so distinct client addresses cannot grow memory without bound; the constructor also accepts an options object.
  - `toErrorResponse` keeps framework client errors (malformed JSON, oversized or unsupported bodies) as 400/413/415 with fixed messages, reported at `warn`, instead of a 500 `INTERNAL_ERROR`; statuses on arbitrary errors are still not trusted.
  - Error reports and tracing spans mask query-string values (`[REDACTED]`); new `redactUrl` helper.
  - Inbound `x-request-id` / `x-correlation-id` are adopted only when they match `^[A-Za-z0-9._:-]{1,128}$`; otherwise a fresh id is generated.
  - `RouteGuard` receives an optional `reply` so guards can set response headers before rejecting.

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

- 36ab1a1: Give route `meta` a shape, and refuse to boot on a plan that is not in the
  catalogue.
  
  **`meta.subscribed` is now checked at boot.** The toolkit already refused to
  boot a route declaring `meta.subscribed` without `subscriptionsPlugin` — it
  checked the *plugin* existed, never that the *value* meant anything.
  `Subscriptions.subscribed()` compares strings and returns false when they do not
  match, and the guard turns that into a 402. So a route gated on a plan absent
  from the catalogue was indistinguishable from one nobody subscribed to: it
  answered 402 to every paying customer, forever, with nothing in the logs.
  
  `subscriptionsPlugin` now validates every `meta.subscribed` against the plans it
  was given and throws `UnknownPlanMetaError`, naming all offending routes at once
  and listing what the catalogue does have. The check runs on `app:booted`, not in
  the plugin's own boot: adapters publish `http:routes` during *their* boot phase,
  so reading the list earlier would depend on plugin order and silently pass.
  
  **`meta` is typed.** It was `Record<string, unknown>`, so `can: 123` compiled.
  `RouteMeta` is exported from `@basaltkit/http` and augmented by each guard
  plugin — `can` by permissions, `subscribed`/`feature` by subscriptions, `auth`
  by auth — the same pattern `BasaltHooks` uses.
  
  It stays open. The index signature keeps every existing route compiling and lets
  applications add their own keys, which means a **misspelt** key still compiles:
  `subcribed: 'pro'` is not a type error. That gap is closed at boot instead, by
  the two checks above. The typing catches wrong value types and lets an editor
  complete the names.

## 1.16.0

### Minor Changes

- c539a6b: **A route can now declare whether it needs a tenant, with `meta.tenant`.**
  
  Separating central routes from tenant routes meant listing paths in
  `required: { except }` — which puts the decision in a different file from the
  route it describes. Rename the URL and the exemption silently stops matching,
  with no error anywhere: the route just starts 404ing for callers who never sent
  a tenant.
  
  ```ts
  // Central: no tenant, ever.
  route({ method: 'GET', url: '/pricing', meta: { tenant: false }, handler })
  
  // Tenant: refuse the request if none resolved.
  route({ method: 'GET', url: '/invoices', meta: { tenant: true }, handler })
  ```
  
  `meta.tenant` overrides the app-wide `required` in both directions, which makes
  the useful combination possible: `required: true` to deny by default, and the
  handful of central routes — health check, landing page, sign-up, tenant
  creation — opting out next to their own handler, where a reviewer sees it.
  
  A central route still *resolves* a tenant when one is present, so `ctx().tenant`
  is populated on `acme.example.com/pricing`. Only the requirement is lifted. A
  non-boolean `meta.tenant` is ignored rather than guessed at, since `meta` is
  free-form and shared with every other plugin.
  
  `required: true`, `required: false` and `required: { except }` are unchanged, and
  remain the right tool for paths you do not own — routes mounted by another
  package.
  
  ### `@basaltkit/http`
  
  `RequestEnricher` now receives the `route` being served, so an enricher can read
  its `meta`. Guards already got this; enrichers did not, which is why tenancy
  could only look at the URL. The field is optional and additive — existing
  enrichers are unaffected — and it is passed from the shared pipeline, so it
  works identically on Fastify, Express and Hono.

## 1.15.0

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

## 1.14.0

### Minor Changes

- 104cfb3: A route pipeline that carries guards but no container now fails closed.
  
  `runRoute` only ran enrichers and guards `if (scoped)` — with no container, every guard was **skipped silently** and the request reached the handler unauthorized. In practice guards and container arrive together (every shipped adapter wires both), so this was a fail-open *shape* rather than a live hole; it is now a `GuardsWithoutContainerError` (`HTTP_GUARDS_UNRUNNABLE`, 500) naming the route and the number of guards that could not run. A pipeline with no guards and no container — the common hand-rolled case — still runs untouched.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.13.0

### Minor Changes

- 59cf29c: `GUARDED_META_KEYS` gains `scopes`, `subscribed` and `feature`, closing an unguarded-route hole.
  
  **Advisory — this tightens boot behavior.** The guarded-meta boot check exists so that a route *declaring* protection can never serve without a guard *enforcing* it. Three keys in that exact class were missing from the set: `meta.scopes` (enforced by `@basaltkit/auth`'s `apiKeysPlugin`) and `meta.subscribed` / `meta.feature` (enforced by `@basaltkit/subscriptions`' `subscriptionsPlugin`). A route declaring any of them with its enforcing plugin absent booted happily and served the scope-gated or paid endpoint to everyone — the failure mode the check was built to prevent.
  
  Those keys are now guarded, and both plugins claim them. An app that declares one of them without registering the enforcing plugin will now **fail at boot** with `UnguardedRouteMetaError` instead of serving unprotected. That is the intended fail-closed outcome, but it can surface as a new boot failure on upgrade. Two remedies, in order of preference: register the enforcing plugin (`apiKeysPlugin`, `subscriptionsPlugin`), or — only when protection genuinely happens at an outer edge — waive it deliberately with the adapter option `allowUnguardedMeta: ['scopes']` (or `['subscribed', 'feature']`).
  
  The boot error now also names the plugin that enforces each offending key, so the fix is in the message.
  
  Keys that *relax* a check rather than request one stay deliberately unguarded: `central` (a `tenantMembershipPlugin` bypass — a missing plugin removes the bypass, never a check), `mcp` (an exposure opt-in) and `rateLimit` (abuse throttling, not an authorization boundary, and legal to declare while `securityPlugin`'s optional rate limiter is off).

## 1.12.0

### Minor Changes

- a76d591: **New: `assertRoutesGuarded` + the `http:guarded-meta` claims bucket — security route-meta must be enforced or the app refuses to boot.**
  
  `meta.auth` / `meta.can` / `meta.teamRole` are *requests* for protection; the guard a plugin registers is what enforces them. A route declaring one of these in an app that never registered the enforcing plugin used to serve **unprotected with zero signal** (verified live: a `meta: { auth: true }` page returned 200 in an app without `authPlugin`).
  
  - `GUARDED_META_KEYS` — the security-relevant keys the framework knows (`auth`, `can`, `teamRole`).
  - `GUARDED_META_BUCKET` (`'http:guarded-meta'`) — enforcing plugins claim the key(s) their guards consume (auth → `'auth'`, permissions → `'can'`, teams → `'teamRole'`). String-keyed metadata — no package coupling. Custom guard plugins that enforce one of these keys should claim it the same way.
  - `assertRoutesGuarded(routes, claimed, allow?)` — throws the new `UnguardedRouteMetaError` listing every offending `METHOD url → key` in one aggregate error. Called by the Fastify/Express/Hono adapters at boot.
  
  `meta.auth: false` / `undefined` are explicit opt-offs, never flagged; non-security meta keys (`rateLimit`, `central`, …) are never flagged.

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
