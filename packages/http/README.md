<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/http

Basalt's neutral HTTP core: defines typed routes, validates request data, and handles errors in a standardized way — the same code then works on Fastify, Express, or Hono. You need it whenever you want to define routes or use the security, health, metrics, tracing, and OpenAPI plugins.

## What this module solves

When you build an API (a server that responds to **HTTP requests** — the messages a browser or an app sends over the internet), you typically choose a framework like Fastify, Express, or Hono. The problem: each one has its own way of defining **routes** (the addresses the server responds to, like `GET /users/:id`), validating data, and handling errors. If you ever switch frameworks, you have to rewrite everything.

`@basaltkit/http` solves this: you define each route **once**, with the `route()` function, in a neutral format that doesn't depend on any framework. Then an **adapter** (`@basaltkit/fastify`, `@basaltkit/express`, or `@basaltkit/hono`) takes those routes and connects them to the chosen framework. Data validation is done with [Zod](https://zod.dev) — a library that describes the shape of data (e.g. "the `name` field is text with at least 3 letters") — and TypeScript types are inferred automatically.

Besides routes, this module brings ready-to-use **edge plugins** for any adapter: security headers, rate limiting, CORS, health probes (`/livez`, `/readyz`), Prometheus metrics (`/metrics`), distributed tracing, and OpenAPI documentation generation.

> **Note**: in practice you almost never use `@basaltkit/http` alone — you also install an adapter. This README covers the building blocks all adapters share.

## Installation

```bash
pnpm add @basaltkit/http zod
```

`zod` is a *peer dependency* (`^4.0.0`) — the module uses it, but the copy is yours, so the project only ever has one. You'll also need an adapter to serve requests, e.g. `pnpm add @basaltkit/fastify`.

## Get started in 5 minutes

Let's define a typed route and serve it with the Fastify adapter.

**Step 1** — install the packages:

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/fastify zod
```

**Step 2** — create a `server.ts` file:

```ts
import { createApp } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { z } from 'zod'

// A route: method + URL + validation + handler (the function that responds).
const hello = route({
  method: 'GET',
  url: '/hello/:name', // :name is a dynamic URL parameter
  params: z.object({ name: z.string() }),
  async handler({ params }) {
    // params.name arrives already validated and typed as string
    return { message: `Hello, ${params.name}!` }
  },
})

const app = await createApp({ plugins: [fastifyPlugin({ routes: [hello] })] }).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
console.log('Listening on http://localhost:3000')
```

**Step 3** — run and test:

```bash
npx tsx server.ts
curl http://localhost:3000/hello/world
# → {"message":"Hello, world!"}
```

## Usage guide

### Defining routes with `route()`

The `route()` function takes a configuration object and returns a route definition. The `body`, `query`, and `params` types in the handler are **inferred** from the Zod schemas — you don't write types by hand.

```ts
import { route, HttpError } from '@basaltkit/http'
import { z } from 'zod'

const createProject = route({
  method: 'POST',
  url: '/projects',
  body: z.object({ name: z.string().min(3) }), // request body (JSON)
  async handler({ body, reply }) {
    // reply lets you control the HTTP status and headers
    return reply.code(201).send({ id: 'p1', name: body.name })
  },
})

const getProject = route({
  method: 'GET',
  url: '/projects/:id',
  params: z.object({ id: z.string() }),
  query: z.object({ expand: z.coerce.boolean().default(false) }),
  async handler({ params, query }) {
    if (params.id === 'nonexistent') {
      throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
    }
    return { id: params.id, expand: query.expand }
  },
})
```

If validation fails, the client automatically receives a standardized `400`:

```json
{ "error": { "code": "HTTP_VALIDATION", "message": "Validation failed in body", "part": "body", "issues": [{ "path": "name", "message": "..." }] } }
```

### Throwing errors with `HttpError`

At any layer of the code you can throw an intentional HTTP error; the adapter converts it into the right response, without exposing internal details:

```ts
import { HttpError } from '@basaltkit/http'

throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
// → 404 response with { error: { code: 'PROJECT_NOT_FOUND', message: '...' } }
```

Unintentional errors (any `throw new Error(...)`) become a generic `500` with the `INTERNAL_ERROR` code — the internal message never reaches the client.

### Structured error details

A domain error the UI has to *act* on — which checks failed, how much quota is left, the current version behind a conflict — used to have nowhere to go but the message, so apps ended up parsing sentences like `Checks failed: A, B`. Pass a fourth options argument instead:

```ts
throw new HttpError(422, 'CHECKS_FAILED', 'Some checks failed.', {
  details: { failed: ['age', 'address'], remaining: 2 },
})
```

```json
{
  "error": {
    "code": "CHECKS_FAILED",
    "message": "Some checks failed.",
    "details": { "failed": ["age", "address"], "remaining": 2 }
  }
}
```

The three-argument form is unchanged and adds no `details` key. The options object also takes the standard `cause`. The same field exists on `BasaltError` (`@basaltkit/core`), so a domain package that throws `BasaltError` with a numeric `status` gets it too:

```ts
class QuotaExceededError extends BasaltError {
  readonly status = 402
  constructor(limit: number, used: number) {
    super('QUOTA_EXCEEDED', 'Plan quota exceeded.', { details: { limit, used } })
  }
}
```

On the client, `@basaltkit/sdk` exposes it as `error.errorDetails` (`BasaltClientError`).

**`details` is public — the rules it is held to.** It reaches the client verbatim, so the neutral serializer sanitises a copy of it (`sanitizeErrorDetails`) before it leaves, and never mutates yours:

| Rule | Behaviour |
|---|---|
| **Yours to keep clean** | No secrets, credentials, internal IDs, SQL or stack traces. The framework cannot tell those apart from data the UI needs — that part is on you. |
| **Plain JSON data only** | Strings, finite numbers, booleans, `null`, arrays, plain objects. A `Date` becomes its ISO string. |
| **Everything else is stripped** | Functions, symbols, `undefined`, BigInt, `NaN`/`Infinity`, and exotic objects — `Error` (its stack is an internal), `Map`/`Set`/`RegExp`, typed arrays and **class instances** (an ORM row would otherwise walk out through an error body). A dropped array element becomes `null` so later indexes do not shift; a `__proto__` key is never copied. |
| **Acyclic and shallow** | A cycle is dropped where it closes; nesting deeper than `MAX_ERROR_DETAILS_DEPTH` (8) is dropped. |
| **Bounded** | Over `MAX_ERROR_DETAILS_BYTES` (4 KiB) of serialised JSON the **whole payload is dropped** — the error still carries `code` and `message`. An error must never become an exfiltration or amplification channel. |
| **Opt-in only** | Only an error explicitly constructed with `details` has any. An unexpected exception is still the neutral `500` with nothing attached, and a framework-raised 4xx (malformed JSON, body too large) never grows one. A deliberate 5xx (`new HttpError(503, …, { details })`) does keep its payload. |
| **Validation is untouched** | A `RequestValidationError` body keeps exactly its `part` + `issues[]` shape and never gains a `details` key. |

Because the whole payload is dropped when it is unsafe or oversized, treat `details` as best-effort enrichment: the client's fallback must always be `code` + `message`.

### The neutral 404 — `NOT_FOUND_RESPONSE`

Every adapter serves the same JSON body for an unmatched route, instead of Fastify's,
Express's or Hono's own default (which differ, and fingerprint the framework):

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found." } }
```

`NOT_FOUND_RESPONSE` is that frozen constant. Each adapter plugin installs it at
`app:booted` and each takes `notFound: false` to opt out (see the adapter READMEs).

### Guarded route meta — fail loud at boot

Six `meta` keys are **security-relevant**, and each one is enforced by a guard that a
plugin registers:

| `meta` key | Enforced by | Package |
|---|---|---|
| `auth` | `authPlugin` | `@basaltkit/auth` |
| `can` | `permissionsPlugin` | `@basaltkit/permissions` |
| `teamRole` | `teamsPlugin` | `@basaltkit/teams` |
| `scopes` | `apiKeysPlugin` | `@basaltkit/auth` |
| `subscribed` | `subscriptionsPlugin` | `@basaltkit/subscriptions` |
| `feature` | `subscriptionsPlugin` | `@basaltkit/subscriptions` |

Declaring one of those keys is a *request* for protection — the guard is what actually
enforces it. So a route that declares `meta: { auth: true }` in an app where `authPlugin`
was never registered would serve **completely open**, silently. Basalt refuses to let that
happen: every adapter calls `assertRoutesGuarded()` during its boot phase and throws
`UnguardedRouteMetaError` (code `HTTP_UNGUARDED_ROUTE_META`) **before any traffic is
served**, listing each offending route and key.

Enforcing plugins claim their key by pushing it into the `'http:guarded-meta'` metadata
bucket (`GUARDED_META_BUCKET`) — a plain string, so there is no package coupling:

```ts
ensureMetadata(container).add('http:guarded-meta', 'can')
```

`meta.<key>` set to `false` or `undefined` is an explicit opt-*off*, not a protection
request, and is never flagged.

Route-meta keys that *relax* a check rather than request one are deliberately **not**
guarded: `central` (skips `tenantMembershipPlugin`'s check — a missing plugin removes a
bypass, never a check), `mcp` (opts a route into MCP exposure) and `rateLimit` (abuse
throttling, not an authorization boundary).

**The escape hatch.** If protection genuinely happens at an outer edge (an API gateway
that authenticates before Basalt ever sees the request), waive the check with the
`allowUnguardedMeta` option — it lives on the **adapter plugin**, identically on all
three:

```ts
fastifyPlugin({ routes, allowUnguardedMeta: true })       // waive every key
expressPlugin({ routes, allowUnguardedMeta: ['auth'] })   // waive only meta.auth
honoPlugin({ routes, allowUnguardedMeta: ['auth', 'can'] })
```

Type: `boolean | string[]`. Default: unset — fail loud.

### Route `meta` the framework reads

`meta` is free-form, but these keys have framework meaning:

| Key | Type | Read by | Effect |
|---|---|---|---|
| `auth` | `boolean` (or plugin-specific) | `@basaltkit/auth` guard | Requires an authenticated user. Boot-checked. |
| `can` | `string \| string[]` | `@basaltkit/permissions` guard | Requires the permission — an array means **all** are required. Boot-checked. |
| `teamRole` | plugin-specific | `@basaltkit/teams` guard | Requires a team-membership rank. Boot-checked. |
| `rateLimit` | `{ limit: number; windowMs: number; key?: RateLimitKey }` | `securityPlugin` | Per-route bucket at a stricter threshold, per IP (default), `'user'`, `'tenant'`, `'user+tenant'` or `(ctx) => id`. |
| `etag` | `true` | the shared pipeline | Strong `ETag` + `304` on `If-None-Match`, for `GET`/`HEAD`. |
| `summary` · `description` · `tags` · `operationId` | `string` · `string` · `string[]` · `string` | `openapiPlugin` | Operation metadata in the generated document. |

`meta.can` accepts a permission string (`'projects:delete'`) **or** a non-empty array of
strings. Anything else — an empty array, a number, an object — is unenforceable, so the
permissions guard throws `InvalidCanMetaError` (`PERMISSION_META_INVALID`, HTTP 500) on
**every request** to that route rather than skipping the check. Authorization fails
closed, loudly.

### Conditional GETs — `meta: { etag: true }`

Opt a read route in and the shared pipeline hashes the serialized body into a strong
`ETag`; when the client sends a matching `If-None-Match`, it replies `304` with no body.
No handler changes, identical on every adapter.

```ts
route({
  method: 'GET',
  url: '/projects/:id',
  meta: { etag: true },
  params: z.object({ id: z.string() }),
  async handler({ params }) { return findProject(params.id) },
})
```

`computeEtag(body)` and `ifNoneMatchSatisfied(header, etag)` are exported if you want to
do it by hand. Only `GET`/`HEAD` are considered, and only when the handler returned a
value without replying itself.

### File uploads — `upload()`

`body: upload({ … })` declares a streamed `multipart/form-data` body that works on
Fastify, Express and Hono alike. It uses the package's own dependency-free RFC 7578
parser, so there is no `@fastify/multipart`/`multer`. The whole pipeline (pre-hooks,
enrichers, guards: rate limit, tenant, auth) runs **before** any body byte is read. The
body is parsed while the handler consumes it, never buffered:

```ts
import { route, upload } from '@basaltkit/http'

route({
  method: 'POST',
  url: '/documents',
  body: upload({ maxBytes: 20 * 1024 * 1024, maxFiles: 3, allowedTypes: ['application/pdf', 'image/*'] }),
  meta: { auth: true },
  async handler({ body }) {
    for await (const file of body.files) {
      // { field, filename (sanitised), declaredType, stream: Readable }
      await files.upload(file.stream, { name: file.filename, contentType: file.declaredType })
    }
    return { title: body.fields['title'] }
  },
})
```

| `UploadOptions` | Type | Default | Past the limit |
|---|---|---|---|
| `maxBytes` | `number` | **required** | `413 PAYLOAD_TOO_LARGE`. Covers the whole request; a larger `Content-Length` is refused before reading. |
| `maxFiles` | `number` | **required** | `400 TOO_MANY_FILES` |
| `maxFileBytes` | `number` | `maxBytes` | `413 PAYLOAD_TOO_LARGE` |
| `maxFields` | `number` | `50` | `400 TOO_MANY_FIELDS` |
| `maxFieldBytes` | `number` | 64 KiB | `413 PAYLOAD_TOO_LARGE` |
| `maxHeaderBytes` | `number` | 8 KiB per part | `400 MALFORMED_MULTIPART` |
| `allowedTypes` | `string[]` | any | `415 UNSUPPORTED_MEDIA_TYPE` (exact `image/png` or wildcard `image/*`, matched against the **declared** type) |

The handler's `body` is an `UploadBody`: `files`, an async iterable of `UploadedFile`,
and `fields`, a null-prototype `Record<string, string>` that fills as parts arrive. A
file you do not read is skipped when you ask for the next one. When the handler
returns or throws before the end, the rest is drained up to `maxBytes` and the reply
gets `Connection: close`, so nothing hangs.

The request is also rejected with `415` when it is not `multipart/form-data`, and with
`400 MALFORMED_MULTIPART` for a missing, repeated or invalid boundary, a body that ends
before the closing boundary, folded, duplicated or oversized part headers, a nested
`multipart/*` part, or a non-binary `Content-Transfer-Encoding`. Filenames go through
`sanitizeFilename()`, which strips directories (`../../x`, `C:\x`), control/NUL and
bidi characters and caps the name at 255 bytes. Treat the result as a label, never as a
storage key. Adapters set `request.bodyStream` (the unread request stream) for upload
routes only; `isUploadBody(schema)` tells them which routes those are. OpenAPI documents
the body as `multipart/form-data`.

### Server-Sent Events — `sse()`

Return `sse(producer)` from a handler and the adapter streams it against its own
transport (a Node response on Fastify/Express, a `ReadableStream` on Hono):

```ts
import { route, sse } from '@basaltkit/http'

const events = route({
  method: 'GET',
  url: '/events',
  async handler() {
    return sse(
      async (stream) => {
        stream.onClose(() => clearInterval(timer))
        const timer = setInterval(() => stream.send({ event: 'tick', data: { at: Date.now() } }), 1000)
      },
      { heartbeatMs: 15_000, maxDurationMs: 300_000 },
    )
  },
})
```

`stream.send()` returns `false` when the stream is closed **or** the transport's write
buffer is full — honour it (slow down) instead of growing memory for a slow client.
`SseOptions`: `heartbeatMs` (comment ping; off when unset) and `maxDurationMs` (hard
lifetime cap; off when unset).

### Security plugin — `securityPlugin()`

Applies three edge protections to any adapter: secure headers, CORS, and rate limiting (limiting how many requests each client can make in a time window).

```ts
import { createApp } from '@basaltkit/core'
import { route, securityPlugin } from '@basaltkit/http'
import { fastifyPlugin } from '@basaltkit/fastify'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [ping] }),
    securityPlugin({
      // Secure headers on by default (HSTS, X-Frame-Options: DENY, etc.)
      headers: true,
      // CORS: only this domain can call the API from a browser
      cors: { origin: ['https://app.example.com'], credentials: true },
      // Max 100 requests per minute per IP address
      rateLimit: { limit: 100, windowMs: 60_000 },
    }),
  ],
}).boot()
```

When the limit is exceeded, the client receives `429` with the `RATE_LIMITED` code and the `Retry-After` header. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.

The default storage is in memory (`MemoryRateLimitStore`) — per process, and bounded:
expired buckets are swept as traffic arrives and at most `maxEntries` (default `100_000`)
are kept, evicting the oldest window first (`new MemoryRateLimitStore({ maxEntries })`).
For a cluster, use the bundled `RedisRateLimitStore`, or implement `RateLimitStore` yourself and pass it in `rateLimit.store`:

```ts
import { RedisRateLimitStore, securityPlugin } from '@basaltkit/http'
import { Redis } from 'ioredis'

securityPlugin({
  rateLimit: { limit: 100, windowMs: 60_000, store: new RedisRateLimitStore(new Redis(process.env.REDIS_URL!)) },
})
```

The rate-limit key is **never** taken from `X-Forwarded-For` (a client can spoof it). It
comes from `request.ip`, which the adapter sets from the socket; when the IP is unknown
every caller shares one bucket (fail closed). Behind a trusted proxy, configure the
adapter to populate `request.ip` (on Fastify: `fastify: { trustProxy: true }`).

**Per-route override.** A route carrying `meta.rateLimit` gets its own bucket, keyed by
client **and** route pattern, at a stricter threshold — so login can be tighter than the
rest. It is enforced by a route guard the plugin registers, so it holds on Fastify,
Express and Hono alike, and when the route runs as an MCP tool. (On Express and Hono the
request also counts against the global bucket, since their edge hook runs before
routing; on Fastify it is counted once.)

```ts
route({
  method: 'POST',
  url: '/auth/login',
  meta: { rateLimit: { limit: 5, windowMs: 60_000 } },
  async handler() { /* … */ },
})
```

Anything malformed in `meta.rateLimit` (missing/non-positive `limit` or `windowMs`) is
ignored and the route falls back to the global bucket.

**Who the bucket belongs to — `meta.rateLimit.key`.** Per IP by default, which lumps
everyone behind one NAT or corporate proxy together. Key it by identity instead:

| `key` (`RateLimitKey`) | Bucket |
|---|---|
| `'ip'` (default) | `request.ip` — as before. |
| `'user'` | `ctx().user.id` — two users behind one IP get separate budgets. |
| `'tenant'` | `ctx().tenant.id` — every user of a tenant shares one budget. |
| `'user+tenant'` | One budget per user per tenant. |
| `(ctx) => string \| undefined` | Whatever id you return (e.g. an API-key id). |

```ts
route({
  method: 'POST',
  url: '/reports/export',
  meta: { auth: true, rateLimit: { limit: 10, windowMs: 60_000, key: 'user' } },
  async handler() { /* … */ },
})
```

The id is resolved in the guard, after enrichers (auth, tenancy) set `ctx()`. When it is
missing — anonymous caller, no tenant, the function returns nothing — the bucket **falls
back to the client IP** (never to one shared bucket; identity buckets are namespaced so
they never collide with IP ones). The same `store` (memory/Redis) is used. A keyed route
is always charged by the guard, so on every adapter it also counts against the global
per-IP bucket (the pre-routing hook cannot know the user). An unknown `key` string keeps
the per-IP bucket.

By default the plugin also sets a **restrictive CSP** — `DEFAULT_CSP`, i.e.
`default-src 'none'; frame-ancestors 'none'` — which is right for a JSON API but blocks
a server-rendered page. See [Server-rendered HTML helpers](#server-rendered-html-helpers)
below for the route-scoped alternative.

### Health probes — `healthPlugin()`

Creates two Kubernetes-style routes:

- `GET /livez` — "is the process alive?" Always responds `200 { status: 'ok' }`, without touching any dependency.
- `GET /readyz` — "is it ready to receive traffic?" Runs every check; if any fails, responds `503`.

```ts
import { healthPlugin } from '@basaltkit/http'

healthPlugin({
  checks: {
    db: async () => ({ ok: true, detail: 'connected' }),
    // A check that throws counts as { ok: false }. The cause is logged with
    // console.error server-side; it never reaches the client.
  },
})
```

The body is `{ status: 'ok' | 'unavailable', checks: { <name>: { ok } } }` — **pass/fail
only**. The `detail` you return from a check is deliberately *not* serialized, because
`/readyz` is usually unauthenticated and a raw error string leaks DB hosts, ports and
DSN fragments.

### Prometheus metrics — `metricsPlugin()`

Serves `GET /metrics` in Prometheus format and automatically instruments all HTTP requests (counter, duration histogram, and in-flight requests), labeled by the route's **template** (`/users/:id`, not `/users/42`, to keep cardinality under control).

```ts
import { METRICS, metricsPlugin } from '@basaltkit/http'

// in the app's plugins:
metricsPlugin()

// elsewhere in the code, for your own metrics:
const registry = app.container.get(METRICS)
registry.counter('jobs_processed_total').inc()
```

### Distributed tracing — `tracingPlugin()`

Records a server *span* per request (a record of "this operation took X ms"), continues a received W3C `traceparent`, returns the `traceparent` header in the response, and exports spans periodically.

```ts
import { tracingPlugin } from '@basaltkit/http'
import { OtlpHttpExporter } from '@basaltkit/core'

tracingPlugin({
  serviceName: 'my-api',
  exporter: new OtlpHttpExporter({ url: 'http://localhost:4318/v1/traces' }),
})
```

### OpenAPI documentation — `openapiPlugin()`

Generates an OpenAPI 3.0 document from the registered routes (including the Zod schemas) and serves it at `GET /openapi.json`:

```ts
import { openapiPlugin } from '@basaltkit/http'

openapiPlugin({ info: { title: 'My API', version: '1.0.0' } })
```

Routes with `meta: { auth: true }` are marked with `bearerAuth` security in the document. The route's `response` field (schemas per status code) feeds the documented responses, and `meta.summary` / `meta.description` / `meta.tags` / `meta.operationId` enrich the operation. Pass `tags` to the plugin to give those groups top-level names and descriptions.

The document is built on `app:booted` — after every plugin has published its routes, and before the server listens — so plugin order never matters.

The same plugin registers a **`generate:docs`** CLI command that writes the
document to disk (or stdout) — handy for CI, publishing, or feeding a static docs
site — without starting the server:

```bash
basalt generate:docs                 # writes openapi.json
basalt generate:docs --out=api.json  # custom path
basalt generate:docs --stdout        # print instead of writing
```

### Advanced: `runRoute()` and the pipeline

Adapters use `runRoute()` to execute each request: it creates the request context (`requestId`, `correlationId`, a scope from the dependency container), runs the **enrichers** (functions that enrich the context, e.g. resolving the tenant), then the **guards** (functions that can reject the request, e.g. authentication — they reject by throwing an error), validates `body`/`query`/`params`, and finally calls the handler. You only need this if you're writing your own adapter.

```ts
import { Container } from '@basaltkit/core'
import { route, runRoute, toErrorResponse } from '@basaltkit/http'

const result = await runRoute(definition, neutralRequest, neutralReply, {
  container: new Container(),
  enrichers: [],
  guards: [],
})
```

Enrichers and guards need the container scope, so a pipeline that carries **guards but no container** throws `GuardsWithoutContainerError` (`HTTP_GUARDS_UNRUNNABLE`, 500) naming the route and how many guards could not run. Skipping them silently would let the request reach the handler unauthorized. A pipeline with no guards and no container runs normally.

## API reference

### `route(config)` → `BasaltRoute`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `method` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'HEAD' \| 'OPTIONS'` | Yes | — | HTTP method. |
| `url` | `string` | Yes | — | Path, with `:name` parameters. |
| `body` | `ZodType` \| `upload(…)` | No | `undefined` | Request body schema; validated at runtime. Or `upload({ … })` for a streamed `multipart/form-data` body (see [Uploads](#file-uploads--upload)). |
| `query` | `ZodType` | No | `undefined` | Query string schema; validated at runtime. |
| `params` | `ZodType` | No | `undefined` | URL parameters schema; validated at runtime. |
| `response` | `Record<number, ZodType>` | No | `undefined` | Response schemas per status — only for OpenAPI/SDK, not validated at runtime. |
| `meta` | `Record<string, unknown>` | No | `undefined` | Free-form metadata read by other plugins (e.g. `auth`, permissions). |
| `handler` | `(args) => unknown` | Yes | — | Receives `{ body, query, params, request, reply }`; the returned value is sent as the response (JSON), unless you've already responded with `reply.send()`. |

### Errors

| Error | Code | HTTP | When |
|---|---|---|---|
| `RequestValidationError` | `HTTP_VALIDATION` | 400 | `body`/`query`/`params` failed its Zod schema. The response carries `part` and `issues[]`. |
| `HttpError(status, code, message, options?)` | *yours* | *yours* | You threw it deliberately from any layer; `status` and `code` are whatever you passed. `options` is `{ details?, cause? }` — `details` is serialized as `error.details` (see [Structured error details](#structured-error-details)). |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | — (boot) | A route declares a guarded key (`auth`/`can`/`teamRole`/`scopes`/`subscribed`/`feature`) and no registered guard claimed that key. Thrown by the adapter at boot, before serving. |
| — (no class) | `NOT_FOUND` | 404 | No route matched. Body is `NOT_FOUND_RESPONSE`; adapters opt out with `notFound: false`. |
| — (no class) | `RATE_LIMITED` | 429 | `securityPlugin`'s limiter rejected the request. `Retry-After` is set. |
| `HttpError` | `PAYLOAD_TOO_LARGE` | 413 | An `upload()` body passed `maxBytes`, `maxFileBytes` or `maxFieldBytes`. |
| `HttpError` | `TOO_MANY_FILES` / `TOO_MANY_FIELDS` | 400 | An `upload()` body passed `maxFiles` / `maxFields`. |
| `HttpError` | `UNSUPPORTED_MEDIA_TYPE` | 415 | An `upload()` route got a non-multipart body, or a file outside `allowedTypes`. |
| `HttpError` | `MALFORMED_MULTIPART` | 400 | Bad boundary, truncated body, malformed/oversized part headers, or a nested multipart part. |
| — (fallback) | `INTERNAL_ERROR` | 500 | Any error that is not an `HttpError` and not a `BasaltError` with a numeric `status`. The real message is never sent to the client. |

`HttpError` and `RequestValidationError` extend `BasaltError`, so `error.code` is stable
and safe to branch on. `ValidationIssue` is `{ path: string; message: string }`.

| Export | Description |
|---|---|
| `HttpErrorOptions` | `{ details?: ErrorDetails; cause?: unknown }` — the fourth argument of `HttpError`. |
| `ErrorDetails` | `Record<string, unknown>` — a structured error payload. |
| `sanitizeErrorDetails(value)` → `ErrorDetails \| undefined` | The client-safety filter the serializer applies: returns a plain, acyclic, bounded copy, or `undefined` when there is nothing safe to send. Never throws. |
| `MAX_ERROR_DETAILS_BYTES` | `4096` — serialised JSON bytes above which the payload is dropped. |
| `MAX_ERROR_DETAILS_DEPTH` | `8` — nesting below which values are dropped. |

`UnguardedRouteMetaError` extends `Error` (not `BasaltError`) and carries `code` as a
readonly field — it is a boot failure, never an HTTP response.

### Pipeline (Advanced — used by adapters)

| Export | Description |
|---|---|
| `runRoute(definition, request, reply, pipeline?)` | Executes a request's full pipeline; returns the handler's value. |
| `toErrorResponse(error)` → `ErrorResponse` | Converts any error into a standardized `{ status, body }`. |
| `RequestEnricher` | `(info: { request, context, container }) => void \| Promise<void>` — runs before the guards. Registered in the `'http:enrichers'` metadata bucket. |
| `RouteGuard` | `(info: { route, request, context, container }) => void \| Promise<void>` — rejects by throwing. Bucket `'http:guards'`. |
| `RoutePipeline` | `{ container?, enrichers?, guards? }`. |

### Neutral server (Advanced — used by adapters and edge plugins)

| Export | Description |
|---|---|
| `HTTP_SERVER` | DI token for the neutral `HttpServer` surface that each adapter registers. |
| `HttpServer` | `use(preHook)`, `after(afterHook)`, `addRoute(method, url, handler)`. |
| `HttpServerCollector` | Implementation that accumulates hooks/routes for the adapter to mount at startup (`runPre`, `runAfter`). |
| `PreHook` / `AfterHook` / `SimpleHandler` | Types for hooks and standalone routes. |

### `securityPlugin(options?)`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `headers` | `SecurityHeadersOptions \| boolean` | No | `true` | Secure headers. `false` turns it off. |
| `cors` | `CorsOptions \| false` | No | off | CORS + response to `OPTIONS` preflight (204). |
| `rateLimit` | `RateLimitOptions \| false` | No | off | Rate limiting with `X-RateLimit-*` headers. |

`SecurityHeadersOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `hsts` | `boolean \| { maxAge?, includeSubDomains?, preload? }` | `true` → `max-age=15552000; includeSubDomains` | Forces HTTPS for the whole domain. `preload` is off unless you ask for it (it's hard to undo). |
| `contentTypeOptions` | `boolean` | `true` → `nosniff` | Stops the browser MIME-sniffing a JSON response into something executable. |
| `frameOptions` | `'DENY' \| 'SAMEORIGIN' \| false` | `'DENY'` | Clickjacking. Loosen only if you intentionally frame your own pages. |
| `referrerPolicy` | `string \| false` | `'no-referrer'` | Keeps URLs (which often carry ids/tokens) out of outbound `Referer` headers. |
| `crossOriginOpenerPolicy` | `string \| false` | `'same-origin'` | Process-isolates the page from cross-origin openers. |
| `cacheControl` | `string \| false` | `DEFAULT_CACHE_CONTROL` = `'no-store'` | **On by default.** Keeps responses carrying tokens, API keys or MFA secrets out of browser and proxy caches. A route that is safe to cache sets its own `Cache-Control` (it replaces this one) — e.g. `private, no-cache` on `meta.etag` routes. |
| `contentSecurityPolicy` | `string \| false` | `DEFAULT_CSP` = `"default-src 'none'; frame-ancestors 'none'"` | **On by default.** Correct for a JSON API (renders nothing, frames nothing). Pass your own string for HTML routes, or `false` to omit the header — but prefer a route-scoped `pageCsp()` over disabling it app-wide. |

`CorsOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `origin` | `boolean \| string \| string[] \| (origin) => boolean` | `true` | `true`/unset reflects the request's `Origin` (or `*` when absent) — **unless `credentials` is on**, in which case reflection is refused and you must give an explicit allowlist. `false` disables CORS. |
| `methods` | `string[]` | `['GET','POST','PUT','PATCH','DELETE','OPTIONS']` | Methods echoed on the preflight. |
| `allowedHeaders` | `string[]` | echoes `Access-Control-Request-Headers`, else `*` | Request headers the browser may send. |
| `exposedHeaders` | `string[]` | — | Response headers JS may read (e.g. `X-RateLimit-Remaining`). |
| `credentials` | `boolean` | `false` | Allows cookies/`Authorization`. Requires an explicit `origin`. |
| `maxAge` | `number` | `600` | Preflight cache seconds. |

A preflight (`OPTIONS` + `Access-Control-Request-Method`) is answered `204` by the plugin
and never reaches your route.

`RateLimitOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `limit` | `number` | Yes | — | Maximum requests per window. |
| `windowMs` | `number` | Yes | — | Window duration in milliseconds. |
| `store` | `RateLimitStore` | No | `new MemoryRateLimitStore()` | Storage for the counters. |
| `key` | `(request) => string` | No | client IP | Aggregation key (e.g. per user). |
| `skip` | `(request) => boolean` | No | — | Returns `true` to exempt the request. |

`MemoryRateLimitStore(clock?)` implements `RateLimitStore` (`hit(key, limit, windowMs)` → `RateLimitResult { allowed, limit, remaining, resetAt, retryAfterMs }`; `reset(key)`). Store methods may be sync or async — the limiter awaits them.

`RedisRateLimitStore(redis, options?)` — takes an ioredis-compatible `RedisLike` client. `RedisRateLimitStoreOptions`: `prefix` (default `'basalt:ratelimit'`) and `now` (clock injection, for tests). Use it whenever more than one process serves traffic.

### `healthPlugin(options?)`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `checks` | `Record<string, HealthCheck>` | No | `{}` | Checks; `HealthCheck` returns `{ ok, detail? }` (or a promise). |
| `livePath` | `string` | No | `'/livez'` | Path for the liveness probe. |
| `readyPath` | `string` | No | `'/readyz'` | Path for the readiness probe. |

### `metricsPlugin(options?)`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `path` | `string` | No | `'/metrics'` | Path for the Prometheus endpoint. |
| `registry` | `MetricsRegistry` | No | new registry | Shared registry (also exposed on the `METRICS` token). |
| `instrumentHttp` | `boolean` | No | `true` | Instruments requests (`http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`). |

### `tracingPlugin(options?)`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `serviceName` | `string` | No | `Tracer` default | Service name in the spans. |
| `exporter` | `SpanExporter` | No | — | Destination for the spans (e.g. `OtlpHttpExporter`, `InMemorySpanExporter` from `@basaltkit/core`). |
| `tracer` | `Tracer` | No | created internally | Your own tracer (ignores `exporter`/`serviceName`). |
| `flushIntervalMs` | `number` | No | `5000` | Export interval. The tracer is also exposed on the `TRACER` token. |

### `openapiPlugin(options)` / `generateOpenApi(routes, info)` / `zodToJsonSchema(schema)`

| Option (`OpenApiPluginOptions`) | Type | Required? | Default | Description |
|---|---|---|---|---|
| `info` | `OpenApiInfo` (`{ title, version, description? }`) | Yes | — | Document metadata. |
| `path` | `string` | No | `'/openapi.json'` | Where to serve the document. |
| `routes` | `RouteLike[]` | No | routes from the `'http:routes'` bucket | Routes to document. |
| `tags` | `OpenApiTag[]` (`{ name, description? }`) | No | `[]` | Top-level tag list, so a docs UI can order and describe the groups. A tag used on an operation but missing here is still listed (name only). |

`generateOpenApi(routes, info)` returns the OpenAPI 3.0.3 document as an object. `zodToJsonSchema(schema)` (Advanced) converts a subset of Zod into JSON Schema; unknown types degrade to `{}` without throwing.

## Common errors and solutions (FAQ)

**"I defined routes but nothing responds."** `@basaltkit/http` doesn't open network ports — it needs an adapter (`@basaltkit/fastify`, `@basaltkit/express`, or `@basaltkit/hono`) to connect the routes to a real server.

**"The response is 400 with `HTTP_VALIDATION` and I sent the right data."** Check the `issues` array in the response: it indicates the field (`path`) and the reason. In `query` and `params` everything arrives as text — use `z.coerce.number()` / `z.coerce.boolean()` to convert.

**"Rate limiting doesn't work with multiple servers."** `MemoryRateLimitStore` lives in each process's memory. Implement `RateLimitStore` on top of Redis and pass it in `rateLimit.store`.

**"My custom error comes out as a generic 500."** Only `HttpError` (or a `BasaltError` with a numeric `status` property) maps to the status you chose; any other error becomes `INTERNAL_ERROR` on purpose, to avoid exposing internal details.

**"My `details` never reach the client."** The payload is dropped whole when it is not plain JSON data (a class instance, a `Map`, an `Error`), when it is deeper than 8 levels, or when its serialised JSON is over 4 KiB — and it is only ever read from an error that was *constructed* with it. Check it with `sanitizeErrorDetails(yourDetails)`: `undefined` means nothing would be sent. See [Structured error details](#structured-error-details).

**"`/readyz` responds 503."** Some check returned `ok: false` or threw an error; the response body carries the detail per check in `checks`.

## Server-rendered HTML helpers

Three footguns, one shared answer each — these back the `*-ui` packages and are available
for any HTML route of your own:

| Export | Signature | Purpose |
|---|---|---|
| `escapeHtml` | `(value: unknown) => string` | Escapes `& < > " '` — one charset that is safe in text nodes **and** inside single- or double-quoted attributes, so pages don't grow divergent `esc()` helpers with attribute-breakout gaps. |
| `scriptJson` | `(value: unknown) => string` | `JSON.stringify` is *not* safe inside `<script>`: a string containing `</script>` ends the element (JSON doesn't escape `/`). This escapes `<` plus U+2028/U+2029. |
| `cspHash` | `(source: string) => string` | The `'sha256-…'` CSP source expression for one inline script/style block. |
| `pageCsp` | `(options?: PageCspOptions) => string` | A locked-down, **route-scoped** CSP for one self-contained page. |

`PageCspOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `scripts` | `string[]` | `[]` | The exact source text of each inline `<script>` block; each is sha256-hashed into `script-src`. With none, `script-src 'none'`. |
| `connect` | `string[]` | `[]` | Extra `connect-src` origins beyond `'self'` (e.g. an absolute `apiBase`). |

The policy it returns is `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'; script-src <hashes>; connect-src 'self' …` (`style-src` must stay `'unsafe-inline'` — hash sources cannot cover `style=""` attributes). Set it as the response's `content-security-policy` header so it overrides
`securityPlugin`'s app-wide `DEFAULT_CSP` **for that page only** — nobody has to weaken
CSP globally to render one HTML page.

The UI packages (`@basaltkit/teams-ui`, `billing-ui`, `api-keys-ui`, `audit-viewer`) do
exactly this and expose a `csp` option: `csp: '<your policy>'` replaces theirs, and
`csp: false` omits the header entirely so an outer proxy can own it.

## How it connects to other modules

- **`@basaltkit/core`** — provides the foundation this module uses: `createApp`/plugins (`definePlugin`), the dependency-injection container (`Container`, tokens), the per-request context (`ctx()`/`runWithContext`), `MetricsRegistry`, `Tracer`, and `BasaltError`.
- **`@basaltkit/fastify` / `@basaltkit/express` / `@basaltkit/hono`** — the adapters: they convert the framework's native request into the neutral `HttpRequest`/`HttpReply`, call `runRoute()`, and register an `HttpServer` on the `HTTP_SERVER` token so this module's edge plugins work on any of them without changes.
- **Feature plugins** (`@basaltkit/auth`, `@basaltkit/tenancy`, `@basaltkit/permissions`, …) — integrate through the pipeline: register *enrichers* in the `'http:enrichers'` metadata bucket and *guards* in `'http:guards'`, and read the routes' `meta` (e.g. `meta: { auth: true }`).
- **Tooling** (CLI `basalt routes`, OpenAPI, `@basaltkit/sdk`) — read the routes exposed by the adapters in the `'http:routes'` bucket, including the Zod schemas.

Guides: [Adapters](/guide/adapters) · [Authorization](/guide/authorization) · [OpenAPI](/guide/openapi) · [Security](/guide/security) · [Observability](/guide/observability) · [Web UI](/guide/web-ui)
