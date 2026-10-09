# @basaltkit/http

## 2.8.0

### Minor Changes

- 0353877: Route security review (BK-025). `@basaltkit/http` adds `describeRoutes()` — a pure normaliser of the `http:routes` bucket into rows with each route's declared `auth`, `can`, `rateLimit`, `tenant` (read from `meta.tenant` only: `'required'`, `'exempt'`, `'central-only'` for `meta.tenant: 'never'`, or `null` when undeclared — new values may be added in a minor, so switch with a `default` branch), `public` and other guarded keys (`meta.central: true`, the `@basaltkit/teams` membership bypass, is listed there as `central`) — and `findUnguardedRoutes()`, which lists the routes missing required guards (explicit opt-outs such as `auth: false` pass; only `auth: true`, the value `authPlugin` enforces, counts as `auth`). Both are also exported from the zod-free subpath `@basaltkit/http/route-table`, so a test can assert on the route table after `app.boot()` without listening. `basalt routes` now prints a column per guard, `--json` prints the rows as one JSON array, and `--unguarded --require=auth,can [--allow=<glob,…>]` lists offenders and exits 1. It checks route meta only: app-wide rate limits, URL-based tenancy, app hooks and edge routes (health, metrics, openapi) are not visible to it. `@basaltkit/cli` now depends on `@basaltkit/http` (it imports only the zod-free subpath).
- eeb90bb: Per-route rate limits without a resolved client IP (BK-046).
  
  - `@basaltkit/http`: when `request.ip` is unresolved (Hono without `getClientIp`, a hand-built `runRoute`, an MCP tool called over stdio or through `McpServer.callTool`), the `meta.rateLimit` guard now keys an identified caller by `user:<id>|tenant:<id>` instead of putting everyone in the shared `unknown` bucket. Anonymous ip-less requests still share the fail-closed `unknown` bucket, and requests with an IP are keyed exactly as before.
  - `@basaltkit/http`: `securityPlugin({ rateLimit })` claims `meta.rateLimit` (new `RATE_LIMIT_META_KEY` export). When routes declare `meta.rateLimit` and no limiter claims it, the adapters' boot check now prints one `console.warn` per app naming those routes. The boot is never refused. Silence the warning with `allowUnguardedMeta: ['rateLimit']` (or `true`). Apps that mount `authRoutes()` without `securityPlugin({ rateLimit })` see it at boot, because the auth routes declare `meta.rateLimit` by default: register the limiter, or pass `authRoutes({ rateLimit: false })` / silence it.
  - Docs: corrected the claim that an unresolved key "never" falls back to one shared bucket. The ip-less behaviour is now documented in the security, adapters and MCP guides (EN and PT) and in the package READMEs.
- e600b0a: Request disposers (BK-077). A `RequestEnricher` may now return a `RequestDisposer` — cleanup for the end of its request, such as releasing a leased database client. Every adapter (Fastify, Express, Hono) runs it exactly once, after `runRoute` has settled and the response is complete — on Fastify/Express once it was sent or abandoned by the client; on Hono a buffered response is complete when it is built, so its disposers are awaited before it is handed to the runtime: after a buffered reply, after a `stream()` download or an `sse()` stream finished, after an error response, when a later enricher or guard rejected the request, or when the client went away. A disposer never runs while the handler is still running: on a client abort mid-handler it waits until `runRoute` has settled, so the handler keeps a live resource (identical on all three adapters). A disposer registered after that point — even the request's first one, e.g. from a timer the handler left behind or a hook on the finished request context — runs at once; one first registered while a `stream()`/`sse()` body is still open waits for its last byte or abort (identical on all three adapters). Disposers run last-registered first, one at a time, each awaited (no timeout: keep them short — one that never settles holds back every disposer registered before it, including `prismaPlugin`'s lease release). Disposer failures are reported on every path: through the adapter's `onError`, through `@basaltkit/mcp`'s `reportError`, and through `console.error` for `runRoute` callers that pass no `onDispose` — always as `REQUEST_DISPOSER_FAILED`, never changing the response. Routes without a disposer pay nothing (listeners are attached lazily).
  
  The same sink is reachable as `ctx().onDispose(disposer)` for cleanup taken outside an enricher's return value (a hook listener, a handler). `runRoute` sets it on the request context only — non-enumerable and read-only (typed `readonly`), so a context copied with a spread (`tenancy.run()`) does not inherit it — and its presence tells a plugin that the running pipeline honours disposers (`@basaltkit/prisma` leases only then).
  
  New exports from `@basaltkit/http`: `RequestDisposer`, `RequestDisposers`, `RoutePipeline.onDispose` and the `RequestContext.onDispose` augmentation. `runRoute` called without `onDispose` (custom adapters) runs the disposers itself when it returns or throws. Because `onDispose` is absent outside a request (inside `tenancy.run()`, in queue/scheduler contexts, on older pipelines), check for it instead of calling `ctx().onDispose?.(…)`, which silently drops the cleanup there. Additive: enrichers returning nothing behave exactly as before.
- e74b21b: BK-083: `RequestEnricher` receives the optional `reply`, so an enricher that refuses a request can set a response header first (e.g. `WWW-Authenticate`). The header survives the shared error envelope on fastify, express and hono (covered by the adapter parity matrix). An enricher that answers the request itself with `reply.send()` now ends it: the remaining enrichers, the guards and the handler no longer run behind a response already sent.
- 3ce3446: OpenAPI documents API keys, scopes and idempotency (BK-083 h), additively — documents of apps without `meta.scopes`, the `apiKey` option or `idempotencyPlugin` are byte-identical:
  
  - A route with `meta.scopes` gets `security: [{ apiKeyAuth: [] }]` and an `x-required-scopes` extension listing its scopes (OpenAPI 3.0.3 allows no scopes in an `apiKey` requirement), even when `meta.auth` is set too — only a key holding the scopes passes that guard.
  - `components.securitySchemes` lists only the schemes used; `apiKeyAuth` is an `apiKey` header scheme (`x-api-key` by default) whose description mentions the `Authorization: Bearer <key>` carrier, the narrow-key rule and every scope the document uses.
  - `meta.auth` routes stay bearer-only unless `apiKey: { header, onAuthRoutes: true }` — opt in only when keys really pass those routes (they carry a `userId`, `apiKeysPlugin` has `users`, and they hold `*` or `allowNarrowKeysOnUnscopedRoutes` is set); `meta.apiKey: false` keeps a route bearer-only.
  - `generateOpenApi(routes, info, tags?, options?)` takes new `GenerateOpenApiOptions` (`apiKey`, `idempotency`); `openapiPlugin` gains `apiKey?: { header, onAuthRoutes? } | false` and `idempotency?: false`. With `idempotencyPlugin` registered, the guarded methods document its header (original case, default `Idempotency-Key`) as an optional parameter. `generate:docs` writes the same document the plugin serves.
  - `IdempotencyStage` gains a read-only `describe()` returning `{ header, methods }`.
- f029638: Rate limits for machine clients (BK-083 g), all additive and identical on Fastify, Express and Hono:
  
  - **`key: 'apiKey'`** for `meta.rateLimit`: one budget per API key (`ctx().apiKey.id`, bucket id `apikey:<id>`). Only a key the API-keys enricher verified becomes a bucket id; without one the usual fallback applies (the global `key`, then the IP, then the user/tenant, then `unknown`). `RateLimitKey` gains the `'apiKey'` member — a `switch` that was exhaustive over it needs a new case. The legacy single object honours `'apiKey'` too (it used to fall back to the IP bucket for that unknown string).
  - **Several budgets on one route**: `meta.rateLimit` takes an array (new `RouteRateLimits` type, for `satisfies`). Budgets are charged in order and the first refusal answers 429 without charging the later ones; `X-RateLimit-*` report the most constraining budget, `Retry-After` the refusing one. Counters are keyed by method, url and array position (`rl|route:<METHOD> <url>#<i>|<identity>`), never by limit/window, so editing a budget keeps the running window. No atomicity across budgets.
  - **Shared buckets**: `bucket: '<name>'` on a budget shares one counter (`rl|bucket:<name>|<identity>`) across every route declaring it. Declarations that disagree on limit, window or key string refuse the boot with `InvalidRouteMetaError` (checked at `app:booted`); function keys are not compared.
  - Malformed new-form declarations refuse the boot through a route-meta validator `securityPlugin` registers: an array (including `[]`) with a malformed entry, or an object whose `bucket` is a string that is not a valid bucket name. This applies only to the array and string-`bucket` forms added in this release. The legacy single object — any object without a string `bucket`, including `bucket: null` or another non-string value — keeps its lenient parse (enforced per route, as before), its store key `<identity>::<url>` and, on Fastify, its pre-routing fast path — unchanged. Caveat: the new forms are always charged in the guard on top of the edge bucket, so on Fastify wrapping a legacy object in an array brings back the global per-IP limit on that route; use `prefixes` to lift it on every adapter.
  - **Path-prefix edge budgets**: `securityPlugin({ rateLimit: { prefixes: [{ prefix: '/v1', limit, windowMs, key? }] } })` charges matching requests (longest prefix, segment-boundary, minimal normalisation: query cut, `//` collapsed, lowercased, trailing `/` dropped, no decoding) on `prefix:<prefix>::<key>` instead of the global bucket — including 404s, preflights and requests an enricher later rejects. `skip` skips them. Bad prefixes throw `TypeError` at construction. New `PrefixRateLimit` type.
  - `describeRoutes()` renders arrays joined by `, ` and shared buckets as `[name]`.
  - The `RateLimitOptions.key` JSDoc now warns against deriving it from an unverified credential header (the docs example did; a client rotating fake `x-api-key` values got a fresh global bucket per request).
- 8b76628: Idempotency moves into the shared route pipeline (BK-084e): `idempotencyPlugin`, `MemoryIdempotencyStore` and `RedisIdempotencyStore` are now exported from `@basaltkit/http` and behave identically on Fastify, Express and Hono. Two opt-in options: `fingerprint` (`'body'` or a function) binds a key to its request and answers a reused key with `422 IDEMPOTENCY_KEY_REUSED`, also against a request still in flight; `replayAfterGuards: true` runs the check after guards and validation, so a revoked caller gets `401`/`403` instead of the cached success. Streams and event streams are never cached. The `IdempotencyStore` contract grows additively (`setPending(key, { fingerprint })`, `{ pending: true, fingerprint }` from `get()`); existing stores keep working. Scope hashes are unchanged, so records already stored keep replaying.
  
  Only the handler's own outcome is recorded: a refusal raised before the handler ran (a guard's `401`/`403`, the rate limiter's `429`, a validation `400`) releases the key instead of being replayed for the whole TTL, so a client honouring `Retry-After` gets its operation run on the retry. So does an `upload()` body refused while the handler streams it (`413` over a limit, `400` malformed, `415` a refused file type, a client closing early) — the same release as for that refusal from a declared `Content-Length` before the handler; retry with a smaller file under the same key and the handler runs. (`rawBody()` is read in full before the handler, so its refusals were already released.) The retry-later statuses `408`, `425` and `429` are never recorded, even from the handler; any other handler `4xx` is still replayed byte-for-byte. Empty responses (`204`) are now recorded and replayed.
  
  Things to know when upgrading:
  - The scope is [caller credentials, raw `x-tenant-id`/`host` headers, method, route pattern, key]. It does not include a tenant resolved another way (path segment, token claim) nor the concrete path params: the same credential reusing a key on `/t/acme/...` and `/t/globex/...`, or on `/orders/1/pay` and `/orders/2/pay`, receives the first response. Mint a fresh key per operation and tenant, and use a `fingerprint` function over `request.url` and the body to refuse such a reuse with `422`. `fingerprint: 'body'` covers the body only, not the query string or path params.
  - By default the check runs after the enrichers, then before the guards: a replay is decided after tenant resolution, so a suspended tenant gets its `403` instead of the replay.
  - With `fingerprint` on, `RedisIdempotencyStore` writes in-flight reservations as `pending:<fingerprint>`, which instances on an older release misread during a rolling deploy: deploy first, then enable `fingerprint`.
  - Only `route()` definitions are covered; a handler registered on the underlying framework by hand is not.
- 36b800c: Route-scoped static response headers (BK-085): `meta.responseHeaders: Record<string, string>` is applied by the shared pipeline as soon as the route matches, before enrichers and guards, so the headers are on every response the route produces — success, a guard's `401`/`403`, a validation `400`, a thrown `500` — identically on Fastify, Express and Hono. They replace a global header of the same name; a handler can still override one. Checked at boot on every adapter: string values without control characters, and never `set-cookie`, `content-type`, `content-length`, `transfer-encoding`, hop-by-hop headers or `x-request-id`. An invalid record logs one `[basalt] invalid meta.responseHeaders …` boot warning naming the routes and is ignored WHOLE (none of its headers, valid siblings included, is ever sent; the request never fails because of it). The next major refuses the boot instead.
  
  The key is `responseHeaders`, not `headers`: `RouteMeta` is an app-owned bag, and an app that already keeps its own data under `meta.headers` (say OpenAPI-style request-header docs) is untouched — nothing reads `meta.headers`, and it is never sent to clients.
- 500edef: `@basaltkit/http` exports `idempotencyHeaderOf(container): string | undefined` — the request header `idempotencyPlugin` reads the key from, lower-cased (`'idempotency-key'` unless renamed with `idempotencyPlugin({ header })`), or `undefined` when the plugin is not registered. It reads the registration as it is now and caches nothing.
  
  `@basaltkit/mcp` now learns the idempotency header through this helper instead of reading `@basaltkit/http`'s internal metadata, so http can change how it stores the stage without breaking tool calls. Behaviour is unchanged: a tool call still never forwards `Idempotency-Key` (always dropped) or the configured custom header. `@basaltkit/http` stays a regular dependency of `@basaltkit/mcp` (not a peer); this release publishes the range as `^2.8.0`, the http minor that adds the helper, and npm installs both together — no peer-dependency change and nothing to do for apps.

### Patch Changes

- 3740447: `rawBody()` and `upload()` now mark their schemas with global `Symbol.for('basalt.http.rawBody')` / `Symbol.for('basalt.http.upload')` properties (non-enumerable, frozen) instead of module-local `WeakMap`s. A schema built by one installed copy of `@basaltkit/http` — e.g. a feature package's nested copy, as with `driveRoutes()` — is now recognised by the adapter's copy, so the route gets its raw bytes / multipart stream instead of failing closed. A cross-copy parity suite runs on Fastify, Express and Hono.
- Updated dependencies [7a3fd88]
  - @basaltkit/core@1.6.0

## 2.7.0

### Minor Changes

- b7171e5: **Error details are public by construction (FA-H05 / BK-050).** `HttpError.details` reached HTTP clients — and, through `@basaltkit/mcp`, the language model in every `isError` tool result — verbatim: sanitised for shape and size, never for sensitivity.
  
  `@basaltkit/http` (minor, additive — HTTP output is unchanged):
  
  - `new HttpError(status, code, message, { internalDetails })` — a log-only channel. The error reporter receives it (the default reporter logs it as an `internalDetails` field, 4xx and 5xx); it is never serialised into a response body or a tool result, and is non-enumerable on the error. `internalDetailsOf(error)` reads it (sanitised) for custom reporters; any error may define the property.
  - `toErrorResponse(error, { redactDetails })` — an optional `ErrorDetailsRedactor` that filters the public `details` (output re-sanitised; a throwing redactor sends none). The adapters pass none.
  - `redactSensitiveDetails`, `isSensitiveDetailsKey`, `REDACTED_DETAIL`, `applyDetailsRedactor` — the stock redactor: anchored, segment-aware sensitive-key matching (kept in step with `@basaltkit/audit`'s `isSensitiveKey`, copied rather than depended on) that masks the values of keys such as `password`, `resetToken`, `apiKey`, `secret`, `sessionId`; booleans and `null` are kept.
  
  `@basaltkit/mcp` (major — the default changes what an MCP client sees):
  
  - A thrown error's `details` now pass through `redactSensitiveDetails` before entering a tool result, so a value under a secret-named key reaches the model as `'[REDACTED]'` instead of verbatim. Configure with `mcpPlugin({ redactErrorDetails })` (also `McpServer`/`collectTools`), or per route with `meta.mcp: { redactErrorDetails }`; `false` restores the previous verbatim output.
  - Tool-call errors are now reported: `mcpPlugin({ reportError })` receives each thrown error with its `internalDetails` (default: the console reporter the Express/Hono adapters use — 5xx to `console.error`, 4xx to `console.warn`). They used to vanish silently. `false` restores the old silence.
  
  Migration: nothing to do unless a tool's client relied on a secret-named key in `details` (it should not) — pass `redactErrorDetails: false` or your own redactor, and move operator-only data to `internalDetails`.

## 2.6.0

### Minor Changes

- b69ea05: Boot-time route-meta validation and side-effect-free route visibility (framework audit FA-044 / FA-035 residuals).
  
  - **Route-meta validators.** Plugins can register a `RouteMetaValidator` in the new `META_VALIDATORS_BUCKET` (`'http:meta-validators'`) to check the *values* their meta keys carry. Every adapter (Fastify, Express, Hono — identically, covered by the shared parity suite) runs them over its full route list at boot, right after the guarded-meta check, and refuses to boot with the new `InvalidRouteMetaError` (`HTTP_INVALID_ROUTE_META`, listing every `route: problem`). A validator that throws counts as a problem. `allowUnguardedMeta` never waives them. `assertRoutesGuarded(routes, container)` now runs them too, and `assertRouteMetaValid(routes, container)` runs them alone — for code driving `runRoute()` without an adapter. Passing a plain `Set` of claimed keys keeps the old behaviour (no validators).
  - **Route visibility.** New `ROUTE_VISIBILITY_BUCKET` (`'http:route-visibility'`) + `RouteVisibilityCheck` contract: a pure, side-effect-free companion of a guard ("could this caller possibly pass?") for surfaces that list routes. `isRouteVisible(route, context, container)` hides a `meta.auth` route from a caller without `context.user` (only when a guard claimed `auth`) and applies every registered check (a throwing check hides the route). Visibility is never authorization.
  - The adapters now pass the container to `assertRoutesGuarded` instead of a `Set`.
- e53db52: Adapter parity helpers and fixes (framework audit FA-080, FA-H25).
  
  - `metricsPlugin`: the `http_requests_in_flight` gauge counts per request. A
    pre-hook that answered before the metrics hook ran (a 429, a CORS preflight)
    still ran the after-hook, and the gauge went negative.
  - `assertRoutesGuarded(routes, container, allow?)` now also takes a booted
    app's container, reading the claimed keys from it — the same boot check the
    adapters make, for code that calls `runRoute()` without an adapter.
  - New `isJsonMediaType()`, `mediaTypeOf()` and `DEFAULT_BODY_LIMIT` (1 MiB): the
    one rule every adapter uses to recognise a JSON body (`application/json` or
    `+json`, never a substring match) and the shared default body limit.
  - `rawBodyRouteMatcher(routes, { caseInsensitive })` for routers that match
    paths regardless of case.
  - Docs: the `RateLimitKey` docstring no longer claims there is never a shared
    bucket — with no resolvable IP every request shares `unknown` (fail closed).

### Patch Changes

- e54b7b1: Security and correctness fixes from the framework audit.
  
  - **Rate-limit buckets that used up their limit are never evicted (FA-014).** `MemoryRateLimitStore` evicted the oldest windows once `maxEntries` was reached — including a client that was currently limited, so a flood of fresh keys (cheap with IPv6) reset it early. Exhausted buckets are now held apart and kept until their window ends; only open windows are evicted, still in amortised O(1).
  - **CORS preflights go through the rate limiter and disclose nothing to disallowed origins (FA-015).** `securityPlugin` answered `OPTIONS` preflights before the rate limiter, so they were never counted; they now count against the global bucket (past it, `429`). A preflight from an origin the `cors` config does not allow still gets `204`, but without `Access-Control-Allow-Methods`, `-Allow-Headers` (which echoed the requested headers) or `-Max-Age`.
  - **A toolkit 500 no longer serialises its internal message (FA-041).** `toErrorResponse` sent the message of any `BasaltError` with a numeric `status` — for internal 500s such as `GuardsWithoutContainerError` or `UserUpdateUnsupportedError` that text names options and internals. A `BasaltError` with `status` 500 now answers its `code` with `Internal server error.` and no `details`; the adapters still report the real error to the log. `HttpError`, errors that set `expose = true`, and other 5xx statuses (a 503 "retry shortly", a 501 "not supported") are client-facing by design and unchanged.
  - **`expose = false` hides an error's message at any status.** A `BasaltError` that sets `expose = false` answers only its `code` and a neutral message (`Bad gateway.` for a 502, `Service unavailable.` for a 503, …) without `details`, and keeps the real text for the log. Used by `OAuthExchangeError` and `DriveHostNotAllowedError`, whose 502 messages quoted an upstream reply or an internal host.
- Updated dependencies [e54b7b1]
  - @basaltkit/core@1.5.0

## 2.5.0

### Minor Changes

- aff3f6a: `rawBody()` — the untouched request bytes, on every adapter (BK-029). **This
  also fixes a real bug in `@basaltkit/subscriptions`: apps may be silently
  failing Stripe/Paddle/Lemon Squeezy webhook verification today.**
  
  **The problem.** Fastify, Express and Hono all parse `application/json` before a
  handler runs, and the neutral layer only left a body unread for `upload()`
  routes. But every webhook provider — Stripe, Paddle, Lemon Squeezy, Dropbox,
  Microsoft Graph, GitHub — signs *the octets it sent*. `JSON.stringify` of the
  parsed object is not an approximation of those octets: different whitespace,
  different key order, `1.50` re-printed as `1.5`. Verify against it and **every
  genuine delivery fails**.
  
  **New — `@basaltkit/http`: `rawBody(options?)`.** A body marker that works the
  way `upload()` does. The adapter leaves the body unread; the pipeline reads it —
  after the pre-hooks, enrichers and guards, never before — and hands the handler
  a `RawBody`: `bytes` (a `Buffer`, exactly what arrived), `text()` (UTF-8),
  `contentType` and `contentLength`. Nothing parses it, this package or the app's
  own parsers. `maxBytes` (default 1 MiB) is enforced on the declared
  `Content-Length` when there is one and on the bytes actually received when there
  is not; past it, `413`. A body the route never got to read is drained and the
  response carries `Connection: close`, so nothing hangs. When a request *declared*
  bytes (a `Content-Length` above zero, or a `Transfer-Encoding`) and none can be
  obtained, the route answers `500 RAW_BODY_UNAVAILABLE` — a deliberate refusal,
  never a reconstruction. A request that declared **no** body has an empty one: a
  zero-length `Buffer`, which is a fact about the request rather than a guess about
  a message, and the shape several providers validate a webhook URL with. In OpenAPI the request body is published as opaque bytes
  (`*/*`, `format: binary`). Also exported: `isRawBody`, `rawBodyOptionsOf`,
  `rawBodyRouteMatcher`, `DEFAULT_RAW_BODY_MAX_BYTES`, and `HttpRequest.bodyBytes`
  for adapters that cannot leave a body unread.
  
  **All three adapters**, with the per-adapter story stated honestly:
  
  - **`@basaltkit/fastify`** — `rawBody()` routes are mounted in their own
    encapsulated scope whose only content-type parser hands the request stream over
    unread, for any content type. Your own parsers are never removed or overridden:
    the adapter's JSON parser, `@fastify/multipart`, anything you registered keeps
    serving every other route, and a non-JSON body on a JSON route still answers
    `415`. No caveat.
  - **`@basaltkit/hono`** — the plugin's bounded pre-read and its pre/after hooks
    step aside for these paths, so the web `Request`'s own stream still carries the
    octets. The route's `maxBytes` bounds it, not `bodyLimit` (the cap must hold
    *after* the guards, not before). No caveat.
  - **`@basaltkit/express`** — `expressPlugin` gives `express.json()` and
    `express.urlencoded()` a `type` filter that returns false for `rawBody()` paths
    (body-parser never reads them) plus a `verify` hook keeping the buffer as a
    second line. Both are installed **only** when a `rawBody()` route exists, so an
    app without one is unchanged. **The one residual caveat:** an app you bring
    yourself with `express.json()` already mounted consumes the stream first — add
    `express.json({ verify: captureRawBody })` (newly exported), or the widespread
    `req.rawBody = buffer` convention, which is honoured too. With neither, the
    route answers `500 RAW_BODY_UNAVAILABLE` rather than guessing.
  
  **Bug fix — `@basaltkit/subscriptions`.** `billingWebhookRoute()` fell back to
  `JSON.stringify(request.body)` whenever the raw body was absent — which it was,
  on every adapter, by default. Against a real Stripe, Paddle or Lemon Squeezy
  endpoint that produces a signature mismatch on **every delivery**: an app wired
  exactly as documented has been answering `400 BILLING_WEBHOOK_INVALID` to
  genuine webhooks, and its subscriptions silently never leave `incomplete`. The
  route now declares `rawBody()` and verifies over the bytes that arrived, on all
  three adapters, with no wiring. **The fallback is gone, not discouraged**: there
  is no path back to a re-serialized body. New: `billingWebhookRoute(gateway,
  { maxBytes })` and `DEFAULT_WEBHOOK_MAX_BYTES` (256 KiB). Nothing to change in
  your app except, on Express with an app-supplied `express.json()`, adding
  `verify: captureRawBody`.
  
  **`@basaltkit/drives`** — also fixes the POST handshake ordering found against
  RFC 0002 Appendix D.5. Microsoft Graph validates a subscription URL with a
  **POST carrying `?validationToken=` and no body at all**, sent before the
  subscription exists. The route demanded the raw bytes first, so wherever they
  could not be produced the handshake was refused and the operator saw
  `subscriptionValidationFailed` on `watch()` — pointing at the subscription
  rather than at whatever consumed the body. A query-borne challenge is now
  answered **before** any bytes are asked for, on one route that handles both
  shapes (Dropbox's on GET, Graph's on POST). Everything else stays fail-closed: a
  POST that is not a handshake still requires the bytes it was signed over; the
  probe never consults a connection (so it cannot say whether one exists) and
  never spends a replay token; and it can only ever produce a challenge — a
  verification failure falls through to the delivery path, which raises it
  properly. The echo keeps `text/plain` + `nosniff` + `no-store` and is now capped
  at 256 characters with control and bidi characters stripped, so an
  unauthenticated caller cannot make the endpoint reflect an unbounded or hostile
  token.
  
  `driveRoutes()`'s notification endpoint now declares
  `rawBody({ maxBytes })` instead of probing for bytes across
  `request.body` / `request.raw.rawBody` / a Hono context value. The three
  documented lines of per-adapter wiring are no longer needed anywhere. The
  fail-closed behaviour is unchanged, and `notifications.rawBody` remains as an
  explicit override for deployments that terminate the request where the neutral
  layer cannot see it. `rawBodyOf()` is renamed `notificationBytes()`.
  
  Tested by a shared adapter-parity suite (`rawBodyParitySuite`) run against all
  three adapters: byte-identical JSON, a body whose whitespace and key order no
  re-serialisation reproduces, a non-JSON body with bytes that are not text, a
  chunked body with no `Content-Length`, the size cap on both the declared and the
  received length, guards running before the body is read, and neighbouring JSON
  routes left parsed and validated exactly as before.

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
