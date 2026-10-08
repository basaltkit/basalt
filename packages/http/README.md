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
The same holds for a toolkit error with `status` 500 (a `BasaltError` such as
`GuardsWithoutContainerError`): the client gets its `code` and `Internal server error.`,
never the developer-facing text or `details`; the adapter's error reporter still logs the
real error. An `HttpError` keeps its message (it is thrown on purpose, for the client), as
does a `BasaltError` that sets `expose = true`. Other 5xx statuses — a 503 "retry
shortly", a 501 "not supported" — are client-facing by design and pass through unchanged.
The opposite opt-in is `expose = false`: whatever its status, such an error answers only
its `code` and a neutral message (`Bad gateway.` for a 502), and keeps its message and
`details` for the log. `OAuthExchangeError` (it quotes the provider's reply) and
`DriveHostNotAllowedError` (it names the host it refused) use it.

An error from an external SDK that merely *carries* a `status` or `statusCode` — a
payment provider's `401 Invalid API key`, an HTTP client's `404` from an upstream — stays
a **500**, on every adapter: it is a failure of this server, not the caller's fault, and
its status describes the upstream call, not this request. Only errors that choose their
status on purpose are honoured: an `HttpError`, a `BasaltError` with a numeric `status`, a
framework's own client error (a body parser's `400`/`413`), or an error that sets
`expose: true` (http-errors style). To pass an upstream status through, catch the SDK
error and throw `new HttpError(…, { cause })`.

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
| **Yours to keep clean** | No secrets, credentials, internal IDs, SQL or stack traces. The framework cannot tell those apart from data the UI needs — that part is on you. Operator-only data goes in `internalDetails` (below). |
| **Plain JSON data only** | Strings, finite numbers, booleans, `null`, arrays, plain objects. A `Date` becomes its ISO string. |
| **Everything else is stripped** | Functions, symbols, `undefined`, BigInt, `NaN`/`Infinity`, and exotic objects — `Error` (its stack is an internal), `Map`/`Set`/`RegExp`, typed arrays and **class instances** (an ORM row would otherwise walk out through an error body). A dropped array element becomes `null` so later indexes do not shift; a `__proto__` key is never copied. |
| **Acyclic and shallow** | A cycle is dropped where it closes; nesting deeper than `MAX_ERROR_DETAILS_DEPTH` (8) is dropped. |
| **Bounded** | Over `MAX_ERROR_DETAILS_BYTES` (4 KiB) of serialised JSON the **whole payload is dropped** — the error still carries `code` and `message`. An error must never become an exfiltration or amplification channel. |
| **Opt-in only** | Only an error explicitly constructed with `details` has any. An unexpected exception is still the neutral `500` with nothing attached, and a framework-raised 4xx (malformed JSON, body too large) never grows one. A deliberate 5xx (`new HttpError(503, …, { details })`) does keep its payload. |
| **Validation is untouched** | A `RequestValidationError` body keeps exactly its `part` + `issues[]` shape and never gains a `details` key. |

Because the whole payload is dropped when it is unsafe or oversized, treat `details` as best-effort enrichment: the client's fallback must always be `code` + `message`.

#### Public vs internal — `internalDetails` and the details redactor

`details` is public **by contract**; two tools help keep it that way.

**The internal channel.** Data the operator needs but the caller must not see — the upstream reply, the conflicting row, an internal job id — goes in `internalDetails`. It is handed to the error reporter (the adapters' `onError`; the default reporter logs it as an `internalDetails` field, for 4xx and 5xx alike) and is **never** serialised into a response body or an MCP tool result. It is a non-enumerable property, so `{ ...error }` or `JSON.stringify(error)` leaves it behind too.

```ts
throw new HttpError(422, 'KYC_FAILED', 'Identity check failed.', {
  details: { failed: ['document'] },                          // the client sees this
  internalDetails: { provider: 'acme-kyc', reply: rawReply }, // the log sees this
})
```

A custom reporter reads it with `internalDetailsOf(report.error)` (sanitised for shape like `details`); any error — not only `HttpError` — can define an `internalDetails` property.

**The redactor.** `toErrorResponse(error, { redactDetails })` filters the (sanitised) public `details` before they enter the body. `redactSensitiveDetails` is the stock one: at any depth, the value of a key that names a secret (`password`, `resetToken`, `apiKey`, `clientSecret`, `privateKey`, `jwt`, `sessionId`, … — segment-aware, so `compass`, `sessionCount`, `author`, `keyId` are left alone) becomes `'[REDACTED]'`; a boolean or `null` under such a key is kept (`{ mfaRequired: true }` carries no secret). A custom redactor gets `(details, { error, status, code })`, its output is sanitised again, and one that throws sends no details (fails closed). The HTTP adapters do not pass a redactor — their output is unchanged; `@basaltkit/mcp` applies `redactSensitiveDetails` by default, because its client is a language model.

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
throttling, not an authorization boundary). A route that declares `meta.rateLimit` with no
limiter registered (`securityPlugin` without `rateLimit`) does not refuse the boot, but
the adapter **warns once** that those budgets are not enforced. Silence it with
`allowUnguardedMeta: ['rateLimit']` (or `true`) when an outer edge throttles.

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

**Without an adapter.** Code that calls `runRoute()` itself (a bespoke listener, a test
harness) gets no boot check for free. Pass the booted app's container and the keys its
plugins claimed are read from it — the same check the adapters make:

```ts
const app = await createApp({ plugins: [authPlugin(…), permissionsPlugin(…)] }).boot()
assertRoutesGuarded(routes, app.container)            // throws UnguardedRouteMetaError
assertRoutesGuarded(routes, app.container, ['auth'])  // same waiver as allowUnguardedMeta
```

**Route-meta validators.** Claiming a key proves a guard enforces it; a
**validator** checks the value. A plugin registers a `RouteMetaValidator` in
`META_VALIDATORS_BUCKET` (`'http:meta-validators'`) — `({ route, container }) =>
problem | problem[] | undefined` (throwing counts as a problem). Every adapter runs
them over its full route list at boot, after the guarded-meta check, and refuses
to start with `InvalidRouteMetaError` (`HTTP_INVALID_ROUTE_META`, `problems[]`).
`allowUnguardedMeta` never waives them. `assertRoutesGuarded(routes, container)`
runs them too; `assertRouteMetaValid(routes, container)` runs them alone. (Passing
a plain `Set` of claimed keys runs no validators.) `teamsPlugin` uses this to fail
the boot on an unknown `meta.teamRole`.

```ts
ensureMetadata(container).add(META_VALIDATORS_BUCKET, (({ route }) =>
  route.meta?.['teamRole'] === 'Admin' ? 'unknown role "Admin"' : undefined) satisfies RouteMetaValidator)
```

**Route visibility.** A guard may publish a pure companion in
`ROUTE_VISIBILITY_BUCKET` (`'http:route-visibility'`): a `RouteVisibilityCheck`
`({ route, context, container }) => boolean | undefined` answering "could this
caller possibly pass?" — with **no side effects** (no rate-limit consumption, no
audit/denial records, no hooks; plain reads are fine). `isRouteVisible(route,
context, container)` combines them (a throwing check hides the route) with one
built-in rule: a `meta.auth` route is hidden from a caller without
`context.user`, when a guard claimed `auth`. Listing surfaces use it —
`@basaltkit/mcp`'s `tools/list`. Visibility is never authorization: guards still
run on every call.

### Route `meta` the framework reads

`meta` is free-form, but these keys have framework meaning:

| Key | Type | Read by | Effect |
|---|---|---|---|
| `auth` | `boolean` (or plugin-specific) | `@basaltkit/auth` guard | Requires an authenticated user. Boot-checked. |
| `can` | `string \| string[]` | `@basaltkit/permissions` guard | Requires the permission — an array means **all** are required. Boot-checked. |
| `teamRole` | plugin-specific | `@basaltkit/teams` guard | Requires a team-membership rank. Boot-checked. |
| `rateLimit` | `RouteRateLimits` — `{ limit; windowMs; key?: RateLimitKey; bucket? }` or an array of them | `securityPlugin` | Per-route bucket(s) at a stricter threshold, per IP (default), `'user'`, `'tenant'`, `'user+tenant'`, `'apiKey'` or `(ctx) => id`; `bucket` shares one across routes. |
| `etag` | `true` | the shared pipeline | Strong `ETag` + `304` on `If-None-Match`, for `GET`/`HEAD`. |
| `headers` | `Record<string, string>` | the shared pipeline | Static response headers set as soon as the route matches — on its errors (guard `401`, validation `400`, thrown `500`) too. Boot-checked: no control characters; not `set-cookie`, `content-type`, `content-length`, `transfer-encoding`, hop-by-hop or `x-request-id`. |
| `summary` · `description` · `tags` · `operationId` | `string` · `string` · `string[]` · `string` | `openapiPlugin` | Operation metadata in the generated document. |

`meta.can` accepts a permission string (`'projects:delete'`) **or** a non-empty array of
strings. Anything else — an empty array, a number, an object — is unenforceable, so the
permissions guard throws `InvalidCanMetaError` (`PERMISSION_META_INVALID`, HTTP 500) on
**every request** to that route rather than skipping the check. Authorization fails
closed, loudly.

### The route table — `describeRoutes()` / `findUnguardedRoutes()`

`describeRoutes(entries)` normalises the `http:routes` bucket every adapter fills at
boot into sorted `RouteRow`s — `{ method, url, auth, can, rateLimit, tenant, public, guards }`
(`auth`/`can`/`rateLimit`/`tenant` are `null` when undeclared; `can: false` becomes
`[]`; `rateLimit` reads `'10/1m per user'`, several budgets joined by `', '` and a shared bucket as `' [name]'`; `tenant` is `'required' | 'exempt' | 'central-only' | 'central'`, where `'central-only'` is `meta.tenant: 'never'`).
`findUnguardedRoutes(rows, { require: ['auth', 'can'], allow? })` returns the rows that
do not declare the required guards, treating `auth: false` / `public: true` (and
`can: false`, for `can`) as intentional; only `auth: true` — the one value `authPlugin`
enforces — satisfies `auth`. Both are pure and also importable from the
zod-free subpath `@basaltkit/http/route-table`; `basalt routes` uses them.

```ts
const app = await buildApp().boot() // no listen needed
const rows = describeRoutes(ensureMetadata(app.container).get('http:routes'))
expect(findUnguardedRoutes(rows, { require: ['auth', 'can'], allow: (r) => r.url === '/health' })).toEqual([])
```

They read route **meta only**: an app-wide rate limit, URL-based tenancy, app hooks
and the edge routes added through `HTTP_SERVER.addRoute()` (health, metrics, openapi)
are not in the table.

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
`fields`, a null-prototype `Record<string, string>` that fills as parts arrive, and
`contentLength`, the request's declared size when the client sent one. A
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

**Streaming a file straight into storage.** Backends that need an exact size (S3) can
stream instead of buffering when you hand them one, so `UploadedFile` carries
`declaredLength`: the part's **own** `Content-Length` header, when the client sent one.
Be honest about what that is — RFC 7578 does not require a per-part `Content-Length` and
no browser sends one, so it is usually `undefined`. The request's `Content-Length`
(`body.contentLength`) covers every part plus the multipart framing, so it is an upper
bound for one file, never its size; there is no way to derive the per-file size before
the bytes arrive. `@basaltkit/files` handles both cases — with no declared length it uses
the configured `validate.maxSize` as the backend's bound:

```ts
for await (const file of body.files) {
  await files.upload(file.stream, {
    name: file.filename,
    contentType: file.declaredType,
    ...(file.declaredLength !== undefined ? { contentLength: file.declaredLength } : {}),
  })
}
```

### Raw request bodies — `rawBody()`

Webhook providers — Stripe, Paddle, Lemon Squeezy, Dropbox, Microsoft Graph, GitHub — sign
**the octets they sent**. A signature can only be checked against those exact bytes, and
`JSON.stringify` of the parsed object is a *different message*: different whitespace,
different key order, `1.50` re-printed as `1.5`. Verify against it and every genuine
delivery fails.

`rawBody()` is the neutral marker that keeps the bytes. It works the same way `upload()`
does: the adapter leaves the body unread, and the pipeline reads it — after the guards —
without parsing it.

```ts
import { rawBody, route } from '@basaltkit/http'

route({
  method: 'POST',
  url: '/webhooks/stripe',
  body: rawBody({ maxBytes: 64 * 1024 }),
  async handler({ body, request }) {
    const event = stripe.webhooks.constructEvent(
      body.text(),                                    // bytes decoded as UTF-8
      request.headers['stripe-signature'] as string,
      process.env.STRIPE_WEBHOOK_SECRET!,
    )
    return { received: true }
  },
})
```

The handler's `body` is a `RawBody`:

| Field | Type | Description |
|---|---|---|
| `bytes` | `Buffer` | Exactly what arrived. Never parsed, never re-serialised. |
| `contentType` | `string \| undefined` | The declared media type, lower-cased and without parameters (`application/json`). The client's claim, not a fact about the bytes. |
| `contentLength` | `number \| undefined` | What the client declared, when it declared one (a chunked body carries none). |
| `text()` | `() => string` | `bytes` decoded as UTF-8 — the form most signature schemes are specified against. Lossy for bytes that are not valid UTF-8; use `bytes` when the scheme is specified over octets. |

| `rawBody()` option | Default | Past it |
|---|---|---|
| `maxBytes` | 1 MiB | `413 PAYLOAD_TOO_LARGE`, refused on the declared `Content-Length` when there is one and on the bytes actually received when there is not |

- **The pipeline runs first.** Pre-hooks (rate limit, CORS), enrichers and guards all run
  before a single body byte is read — the same guarantee `upload()` gives.
- **Nothing hangs.** A body the route never got to read (a guard rejected first) is
  drained up to `maxBytes` and the response carries `Connection: close`.
- **No fallback, ever.** When a request *declared* bytes (a `Content-Length` above zero, or
  a `Transfer-Encoding`) and no adapter can supply them, the route answers
  `500 RAW_BODY_UNAVAILABLE`. It refuses rather than verify a message nobody sent.
- **A request that declared no body has an empty one.** `Content-Length: 0`, or no framing
  headers at all, yields a zero-length `Buffer` — a fact about the request, not a guess
  about a message. This matters: several providers validate a webhook URL with a **POST
  carrying no body** (Microsoft Graph's `?validationToken=` handshake, sent before the
  subscription exists). Refusing those would report a body-parser problem as a
  subscription failure.
- **In OpenAPI** the request body is published as opaque bytes (`*/*`, `format: binary`).

#### Per-adapter notes

| Adapter | How the bytes survive | Caveat |
|---|---|---|
| **Fastify** | `rawBody()` routes are mounted in their own encapsulated scope, whose only content-type parser hands the request stream over unread for any content type. | None. Parsers you registered yourself are never removed or overridden; every other route keeps going through them, and a non-JSON body on a JSON route still answers 415. |
| **Hono** | The plugin's bounded pre-read and its pre/after hooks step aside for these paths, so the web `Request`'s own stream still carries the octets. | None. `bodyLimit` does not bound the route; its own `maxBytes` does. |
| **Express** | `expressPlugin` gives `express.json()`/`express.urlencoded()` a `type` filter that returns false for `rawBody()` paths (body-parser never reads them) plus a `verify` hook keeping the buffer as a second line. Both only when a `rawBody()` route exists. | One — see below. |

**The Express caveat.** `express.json()` is app-wide, so an app you built yourself with
its own parser already mounted consumes the stream before any Basalt route runs. Give the
parser a `verify` hook and the bytes survive:

```ts
import { captureRawBody, expressPlugin } from '@basaltkit/express'

app.use(express.json({ verify: captureRawBody }))
app.use(express.urlencoded({ extended: false, verify: captureRawBody }))
```

The widespread `verify: (req, _res, buf) => { req.rawBody = buf }` convention is honoured
too. With neither, the route answers `500 RAW_BODY_UNAVAILABLE` rather than guessing.

### Streaming responses — `stream()`

Return `stream(source, options)` from a handler and the adapter sends the bytes without
ever collecting them: Fastify pipes the `Readable`, Express uses `pipeline()`, Hono
answers with a `Response` over a web stream. `source` is a Node `Readable`, a web
`ReadableStream` or any `AsyncIterable<Uint8Array>`.

```ts
import { route, stream } from '@basaltkit/http'

route({
  method: 'GET',
  url: '/invoices/:id/pdf',
  meta: { auth: true },
  async handler({ params }) {
    const { record, stream: body } = await files.downloadStream(params.id)  // 423/403 here, before any byte
    return stream(body, {
      contentType: record.contentType,
      contentLength: record.size,       // omit when unknown — the response is then chunked
      filename: record.name,            // Content-Disposition: attachment, sanitised
    })
  },
})
```

| `StreamOptions` | Type | Default | What it does |
|---|---|---|---|
| `contentType` | `string` | `application/octet-stream` | `Content-Type` of the body. |
| `contentLength` | `number` | *(none)* | `Content-Length`, when the exact size is known. Never guess: a wrong value truncates or hangs the download. |
| `filename` | `string` | *(none)* | `Content-Disposition` with the name, run through `sanitizeFilename()` and encoded per RFC 5987 (printable-ASCII `filename=` fallback plus `filename*=UTF-8''…`). |
| `disposition` | `'attachment' \| 'inline'` | `attachment` | Only read when `filename` is set. `attachment` is the default on purpose: an uploaded HTML/SVG file must never render on your origin. |
| `headers` | `Record<string, string>` | `{}` | Extra headers (CR/LF stripped from every value). |
| `status` | `number` | `200` | Response status. |

What every adapter guarantees, held to the same parity suite:

- **Never buffered, and backpressure is real.** A slow client slows the source; nothing
  accumulates in memory.
- **A disconnect destroys the source**, so no file descriptor or backend socket leaks
  when a user closes the tab mid-download.
- **An error before the first byte is a normal JSON error response** — the streaming
  headers are withdrawn and the usual `{ error: { code, message } }` envelope is sent.
- **An error after the headers cuts the connection.** Nothing is ever appended to a body
  that is already partly sent; the client sees a truncated download, and the failure is
  reported **once** through the adapter's `onError` reporter (status 500, code
  `STREAM_FAILED`).
- **`HEAD` sends no body**, keeps the headers a `GET` would have carried, and reads
  nothing from the source.
- `meta: { etag: true }` is skipped for a streamed body — there is no payload to hash.

There is deliberately no `maxDurationMs` here (unlike `sse()`): a large download
legitimately takes a long time, and a framework-level cap would truncate it. Bound it at
the server instead — `fastifyPlugin({ fastify: { requestTimeout, connectionTimeout } })`,
Express's `server.setTimeout()`, or your runtime's own limit on Hono.

| Export | Description |
|---|---|
| `stream(source, options?)` → `StreamResponse` | What the handler returns. |
| `StreamSource` | `Readable \| ReadableStream<Uint8Array> \| AsyncIterable<Uint8Array>`. |
| `contentDisposition(filename, disposition?)` | The header value on its own, if you build one by hand. |
| `isStreamResponse` / `streamPayloadOf` | Adapter plumbing: recognise the marker, read `{ source, status, headers }`. |
| `toNodeStream` / `destroyStreamSource` | Adapter plumbing: any source as a Node `Readable`; release a source nobody will read. |
| `streamPump` / `openStreamPump` / `nodeStreamFrom` / `webStreamFrom` | Adapter plumbing: pull one chunk at a time, peek the first chunk before the headers flush, rebuild a Node or web stream from the pump. |

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
A bucket that has used up its limit is never evicted — a flood of new client addresses
cannot free a limited client early; it is held until its window ends.
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
back to the client IP** (identity buckets are namespaced so they never collide with IP
ones). When `request.ip` itself is unresolved — Hono without `getClientIp`, a hand-built
`runRoute`, an MCP tool called over stdio or through `McpServer.callTool` — the guard keys
an identified caller by `user:<id>|tenant:<id>` (as `'user+tenant'` would), and **every
anonymous ip-less request shares one fail-closed `unknown` bucket**. Configure the adapter
to resolve the client IP to get per-client buckets back. The same `store` (memory/Redis) is used. A keyed route
is always charged by the guard, so on every adapter it also counts against the global
per-IP bucket (the pre-routing hook cannot know the user). An unknown `key` string keeps
the per-IP bucket.

`'apiKey'` keys the bucket by `ctx().apiKey.id` — only a key `apiKeysPlugin` verified, so
made-up keys fall back like any missing id. Never derive the **global** `rateLimit.key`
from a credential header: it runs before authentication, and a client rotating made-up
values would get a fresh bucket per request.

**Several budgets, shared buckets.** `meta.rateLimit` also takes an array
(`RouteRateLimits`): every budget is enforced in order, the first refusal answers 429 and
the later ones are not charged (put the burst first). `bucket: 'name'` shares one budget
across every route declaring it; all declarations must agree on `limit`, `windowMs` and key
string, or the boot is refused (`InvalidRouteMetaError`). These forms are charged in the
guard on every adapter, on top of the edge bucket — on Fastify that differs from the
single object, which replaces the global bucket.

```ts
meta: {
  rateLimit: [
    { limit: 10, windowMs: 1_000, key: 'apiKey' },
    { limit: 50_000, windowMs: 86_400_000, key: 'tenant', bucket: 'public-api-daily' },
  ] satisfies RouteRateLimits,
}
```

**Path-prefix budgets.** `rateLimit.prefixes: [{ prefix: '/v1', limit, windowMs, key? }]`
charges matching paths on their own pre-routing bucket instead of the global one (longest
prefix wins, segment-boundary match, minimal normalisation), on every adapter — the way to
lift the per-IP ceiling for a public API. Prefixes set or lift a budget; a budget that
must hold for one endpoint belongs in its `meta.rateLimit`.

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

`http_requests_in_flight` is counted per request: a request an earlier pre-hook answered
(a `429`, a CORS preflight) is never uncounted, and open `sse()` streams and responses the
client abandoned are released when they end, on every adapter.

`/metrics` (like `/openapi.json` and the health probes) is an **edge route**: enrichers
and guards do not run on it, so it is public on whatever listener serves the app. Keep it
off the public listener, or put a pre-hook in front of it.

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

Routes with `meta: { auth: true }` are marked with `bearerAuth` security in the document; routes with `meta.scopes` get an `apiKeyAuth` scheme (header `x-api-key`, or `apiKey: { header }`) plus an `x-required-scopes` extension listing the scopes (OpenAPI 3.0.3 allows no scopes in an `apiKey` requirement). `apiKey: { header, onAuthRoutes: true }` also offers the key on `meta.auth` routes — only when your keys really pass them; `apiKey: false` hides the scheme. With `idempotencyPlugin` registered, guarded methods document its `Idempotency-Key` header (`idempotency: false` hides it). The route's `response` field (schemas per status code) feeds the documented responses, and `meta.summary` / `meta.description` / `meta.tags` / `meta.operationId` enrich the operation. Pass `tags` to the plugin to give those groups top-level names and descriptions.

The document is built on `app:booted` — after every plugin has published its routes, and before the server listens — so plugin order never matters.

The same plugin registers a **`generate:docs`** CLI command that writes the
document to disk (or stdout) — handy for CI, publishing, or feeding a static docs
site — without starting the server:

```bash
basalt generate:docs                 # writes openapi.json
basalt generate:docs --out=api.json  # custom path
basalt generate:docs --stdout        # print instead of writing
```

### Idempotent mutations — `idempotencyPlugin()`

Repeating a request must not repeat its effect. When a client sends an `Idempotency-Key`,
the first response is stored and every repeat with the same key receives **the same
response** without running the handler again — a network retry never charges a card
twice. It runs inside the shared route pipeline (`runRoute`), so it behaves identically on
Fastify, Express and Hono.

```ts
import { createApp } from '@basaltkit/core'
import { idempotencyPlugin, RedisIdempotencyStore } from '@basaltkit/http'
import { Redis } from 'ioredis'

createApp({
  plugins: [
    expressPlugin({ routes }), // or fastifyPlugin / honoPlugin
    idempotencyPlugin({
      store: new RedisIdempotencyStore(new Redis(process.env.REDIS_URL!)), // default: in-memory
      fingerprint: 'body',     // a different body under the same key → 422
      replayAfterGuards: true, // a revoked caller gets 401/403, not the cached success
    }),
  ],
})
```

Rules:
- Every handler shape is covered: one that returns its payload is replayed exactly like
  one that sends it through `reply.send()`. A replay carries `Idempotent-Replayed: true`.
- A repeat while the first request is still in flight → `409 IDEMPOTENCY_CONFLICT`.
- Only the **handler's own** outcome is stored. A refusal raised before the handler ran —
  a guard's `401`/`403`, the rate limiter's `429`, a validation `400`, an unreadable body —
  releases the key, so the retry (after `Retry-After`, or once signed in) runs the operation.
- Responses `>= 500`, the retry-later statuses `408`, `425` and `429` (even from the
  handler), `stream()` and `sse()` responses are **not** stored. Any other client error the
  handler throws or sends (`4xx`) is stored and replayed byte-for-byte.
- Keys are scoped by **caller credentials + tenant headers + method + route pattern + key**;
  the store only sees a SHA-256 of that scope. Credentials are every header in
  `credentialHeaders` (default `authorization`, `x-session-id`, `cookie`, `x-api-key`); the
  tenant part is only the raw `x-tenant-id` + `host` headers. Requests with none of the
  credential headers are skipped unless `allowAnonymous: true`.
- **What the scope does not cover:** a tenant resolved another way (a path segment such as
  `/t/:tenant/...`, a token claim) and the concrete path params. The same credential
  reusing one key on `/t/acme/orders` and `/t/globex/orders`, or on `/orders/1/pay` and
  `/orders/2/pay`, receives the **first** response. Have clients mint a fresh key per
  operation (and per tenant), and bind the key to the URL with a fingerprint function so
  such a reuse is refused with `422`:
  `fingerprint: ({ request }) => request.url + '\n' + JSON.stringify(request.body)`.
- `fingerprint: 'body'` binds the key to the body: canonical JSON (sorted keys) of a parsed
  body, the exact bytes of a `rawBody()` route — **not** the query string or the path
  params. A mismatch → `422 IDEMPOTENCY_KEY_REUSED`, also against a request still in
  flight. `upload()` routes need a function: `fingerprint: ({ route, request }) => string | undefined`.
- By default the check runs after the enrichers and **before** the guards — so a replay is
  decided after, e.g., tenant resolution: a suspended tenant gets its `403`, not the replay.
  `replayAfterGuards: true` runs it after guards and validation, just before the handler.
  A `rawBody()` route fingerprinted by `'body'` is always checked after the guards.
- An `Idempotency-Key` longer than 255 characters → `400 IDEMPOTENCY_KEY_INVALID`.
- The reservation is an **atomic** `setPending()` before the handler runs.
- Only Basalt `route()` definitions are covered — not handlers registered on the
  underlying framework by hand. A raw `fastify.post(...)` (or `app.post(...)` on Express or
  Hono) is **not** protected: declare it with `route()` and pass it to the adapter plugin.
- Rolling deploys: with `fingerprint` on, `RedisIdempotencyStore` writes in-flight
  reservations as `pending:<fingerprint>`; an instance running a release older than this
  one reads that as a completed record and fails the repeat. Roll out with `fingerprint`
  off, then turn it on. Empty responses (`204`) are stored and replayed too.

`fingerprint` and `replayAfterGuards` default to off so existing apps keep their
behaviour; a future major turns them on.

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
| `body` | `ZodType` \| `upload(…)` \| `rawBody(…)` | No | `undefined` | Request body schema; validated at runtime. Or `upload({ … })` for a streamed `multipart/form-data` body (see [Uploads](#file-uploads--upload)), or `rawBody({ … })` for the untouched request bytes (see [Raw request bodies](#raw-request-bodies--rawbody)). |
| `query` | `ZodType` | No | `undefined` | Query string schema; validated at runtime. |
| `params` | `ZodType` | No | `undefined` | URL parameters schema; validated at runtime. |
| `response` | `Record<number, ZodType>` | No | `undefined` | Response schemas per status — only for OpenAPI/SDK, not validated at runtime. |
| `meta` | `Record<string, unknown>` | No | `undefined` | Free-form metadata read by other plugins (e.g. `auth`, permissions). |
| `handler` | `(args) => unknown` | Yes | — | Receives `{ body, query, params, request, reply }`; the returned value is sent as the response (JSON), unless you've already responded with `reply.send()`. |

### Errors

| Error | Code | HTTP | When |
|---|---|---|---|
| `RequestValidationError` | `HTTP_VALIDATION` | 400 | `body`/`query`/`params` failed its Zod schema. The response carries `part` and `issues[]`. |
| `HttpError(status, code, message, options?)` | *yours* | *yours* | You threw it deliberately from any layer; `status` and `code` are whatever you passed. `options` is `{ details?, internalDetails?, cause? }` — `details` is serialized as `error.details` (see [Structured error details](#structured-error-details)); `internalDetails` only reaches the error reporter. |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | — (boot) | A route declares a guarded key (`auth`/`can`/`teamRole`/`scopes`/`subscribed`/`feature`) and no registered guard claimed that key. Thrown by the adapter at boot, before serving. |
| `InvalidRouteMetaError` | `HTTP_INVALID_ROUTE_META` | — (boot) | A route-meta validator (`META_VALIDATORS_BUCKET`) refused one or more routes; `problems[]` lists each `{ route, problem }`. Thrown by the adapter at boot; never waived by `allowUnguardedMeta`. |
| — (no class) | `NOT_FOUND` | 404 | No route matched. Body is `NOT_FOUND_RESPONSE`; adapters opt out with `notFound: false`. |
| — (no class) | `RATE_LIMITED` | 429 | `securityPlugin`'s limiter rejected the request. `Retry-After` is set. |
| `HttpError` | `PAYLOAD_TOO_LARGE` | 413 | An `upload()` body passed `maxBytes`, `maxFileBytes` or `maxFieldBytes`, or a `rawBody()` body passed its `maxBytes`. |
| `HttpError` | `TOO_MANY_FILES` / `TOO_MANY_FIELDS` | 400 | An `upload()` body passed `maxFiles` / `maxFields`. |
| `HttpError` | `UNSUPPORTED_MEDIA_TYPE` | 415 | An `upload()` route got a non-multipart body, or a file outside `allowedTypes`. |
| `HttpError` | `MALFORMED_MULTIPART` | 400 | Bad boundary, truncated body, malformed/oversized part headers, or a nested multipart part. |
| `HttpError` | `RAW_BODY_UNAVAILABLE` | 500 | A `rawBody()` route ran on an adapter that could not supply the bytes — another body parser consumed them first. A deliberate refusal, never a reconstruction. See [Raw request bodies](#raw-request-bodies--rawbody). |
| — (fallback) | `INTERNAL_ERROR` | 500 | Any error that is not an `HttpError` and not a `BasaltError` with a numeric `status`. The real message is never sent to the client. A `BasaltError` other than `HttpError` with `status` 500 (and no `expose = true`) keeps its code but gets this message too. |

`HttpError` and `RequestValidationError` extend `BasaltError`, so `error.code` is stable
and safe to branch on. `ValidationIssue` is `{ path: string; message: string }`.

| Export | Description |
|---|---|
| `HttpErrorOptions` | `{ details?: ErrorDetails; internalDetails?: ErrorDetails; cause?: unknown }` — the fourth argument of `HttpError`. |
| `ErrorDetails` | `Record<string, unknown>` — a structured error payload. |
| `sanitizeErrorDetails(value)` → `ErrorDetails \| undefined` | The client-safety filter the serializer applies: returns a plain, acyclic, bounded copy, or `undefined` when there is nothing safe to send. Never throws. |
| `toErrorResponse(error, options?)` | The neutral error serializer every adapter shares. `options.redactDetails?: ErrorDetailsRedactor` filters the public `details` (default: none). |
| `ErrorDetailsRedactor` | `(details, { error, status, code }) => ErrorDetails \| undefined` — output re-sanitised; a throwing redactor sends no details. |
| `redactSensitiveDetails(details)` / `isSensitiveDetailsKey(key)` / `REDACTED_DETAIL` | The stock redactor (masks the values of secret-named keys, keeps booleans/`null`), its key test, and its `'[REDACTED]'` marker. |
| `internalDetailsOf(error)` → `ErrorDetails \| undefined` | An error's log-only `internalDetails`, sanitised for shape — for custom reporters. |
| `MAX_ERROR_DETAILS_BYTES` | `4096` — serialised JSON bytes above which the payload is dropped. |
| `MAX_ERROR_DETAILS_DEPTH` | `8` — nesting below which values are dropped. |

`UnguardedRouteMetaError` extends `Error` (not `BasaltError`) and carries `code` as a
readonly field — it is a boot failure, never an HTTP response.

### Pipeline (Advanced — used by adapters)

| Export | Description |
|---|---|
| `runRoute(definition, request, reply, pipeline?)` | Executes a request's full pipeline; returns the handler's value. |
| `toErrorResponse(error)` → `ErrorResponse` | Converts any error into a standardized `{ status, body }`. |
| `RequestEnricher` | `(info: { request, context, container, route?, reply? }) => void \| RequestDisposer \| Promise<void \| RequestDisposer>` — runs before the guards. Registered in the `'http:enrichers'` metadata bucket. An enricher that answers the request itself (`reply.send()`) ends it: the remaining enrichers, the guards and the handler do not run. A returned disposer runs exactly once when the response has ended (sent, streamed out, failed or abandoned) and the handler has settled — never while the handler still runs after a client abort — on every adapter. |
| `RequestDisposer` | `() => void \| Promise<void>` — cleanup an enricher returns (e.g. releasing a leased database client). |
| `ctx().onDispose` | `(disposer: RequestDisposer) => void \| undefined` — hands a disposer to the current request from outside an enricher's return value (a hook listener, a handler). Set by `runRoute` on the request context only (non-enumerable, so a context copied by `tenancy.run()` does not inherit it); absent outside a request and before 2.8, which tells a plugin not to take what it cannot give back. |
| `RequestDisposers` | Per-request disposer list for adapter authors: `add(disposer)`, once-guarded `run()` (last-registered first; a disposer added after `run()` runs at once). |
| `RouteGuard` | `(info: { route, request, context, container }) => void \| Promise<void>` — rejects by throwing. Bucket `'http:guards'`. |
| `RoutePipeline` | `{ container?, enrichers?, guards?, onDispose? }`. `onDispose` receives the disposers enrichers return; an adapter passes it and runs them once `runRoute` has settled and the response has ended. Without it, `runRoute` runs them itself when it returns or throws. |
| `assertRoutesGuarded(routes, claimed, allow?)` | The boot check every adapter runs. `claimed` is a `Set` of claimed keys or a booted `Container` (the keys are read from its `'http:guarded-meta'` bucket). |
| `describeRoutes(entries)` → `RouteRow[]` · `findUnguardedRoutes(rows, { require, allow? })` | The route table with declared guards, and the routes missing required guards — see [The route table](#the-route-table--describeroutes--findunguardedroutes). Also at `@basaltkit/http/route-table`. |
| `isJsonMediaType(contentType)` | `true` for `application/json` or a `+json` type, parameters and case ignored — never a substring match (`text/plain; application/json` is CORS-safelisted, not JSON). The rule every adapter parses bodies by. |
| `mediaTypeOf(contentType)` | The bare, lower-cased media type of a `Content-Type` header (`''` when absent). |
| `DEFAULT_BODY_LIMIT` | `1048576` (1 MiB) — the default body limit of every adapter. |
| `rawBodyRouteMatcher(routes, { caseInsensitive? })` | Tells whether a method + path belongs to a `rawBody()` route, for adapters that parse in middleware. `caseInsensitive` for a router that matches regardless of case. |

### Neutral server (Advanced — used by adapters and edge plugins)

| Export | Description |
|---|---|
| `HTTP_SERVER` | DI token for the neutral `HttpServer` surface that each adapter registers. |
| `HttpServer` | `use(preHook)`, `after(afterHook)`, `addRoute(method, url, handler)`. |
| `HttpServerCollector` | Implementation that accumulates hooks/routes for the adapter to mount at startup (`runPre`, `runAfter`). |
| `PreHook` / `AfterHook` / `SimpleHandler` | Types for hooks and standalone routes. |

### `idempotencyPlugin(options?)` → Basalt plugin (`basalt:idempotency`)

| Option | Type | Default | Description |
|---|---|---|---|
| `store` | `IdempotencyStore` | `new MemoryIdempotencyStore(ttlMs)` | Where outcomes live. `RedisIdempotencyStore` shares them across instances. |
| `header` | `string` | `'idempotency-key'` | Header carrying the key. |
| `methods` | `string[]` | `['POST']` | Methods the check applies to. |
| `ttlMs` | `number` | `86_400_000` (24 h) | Retention of the default in-memory store. |
| `credentialHeaders` | `string[]` | `authorization`, `x-session-id`, `cookie`, `x-api-key` | Headers folded into the replay scope. |
| `allowAnonymous` | `boolean` | `false` | Also cache requests carrying none of the credential headers. |
| `fingerprint` | `'body' \| false \| (input) => string \| undefined` | `false` | Bind a key to its request; a mismatch → `422 IDEMPOTENCY_KEY_REUSED`. |
| `replayAfterGuards` | `boolean` | `false` | Run the check after guards and validation instead of before the guards. |

`IdempotencyStore`: `get(key)` → `IdempotencyRecord | IdempotencyPending | 'pending' | undefined`;
`setPending(key, info?)` → `boolean` (**an atomic check-and-set** — Redis `SET NX`, or one
synchronous step in-process; `info.fingerprint` may be kept on the reservation and returned
as `{ pending: true, fingerprint }`); `complete(key, record)`; `release(key)`.
`IdempotencyRecord` = `{ status, body, contentType?, fingerprint? }`. A store that ignores
fingerprints keeps working; a concurrent repeat is then a `409` rather than a `422`.
`MemoryIdempotencyStore(ttlMs?, clock?, { maxEntries? })` is the in-process store (default
10 000 entries, oldest evicted first). `RedisIdempotencyStore(redis, { prefix?, ttlMs? })`
takes any ioredis-compatible `RedisIdempotencyClient` (`get`/`set`/`del`).

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
and never reaches your route. It counts against the global rate limit like any other
request (past it the preflight gets `429`), and the `Access-Control-Allow-Methods`,
`-Allow-Headers` and `-Max-Age` headers are sent only to an allowed origin — a disallowed
one gets a bare `204`.

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

**"My custom error comes out as a generic 500."** Only `HttpError` (or a `BasaltError` with a numeric `status` property, or an error with `expose: true`) maps to the status you chose; any other error becomes `INTERNAL_ERROR` on purpose, to avoid exposing internal details. That includes an SDK error carrying its upstream `status` — wrap it in an `HttpError` if the client should see it.

**"`http_requests_in_flight` went negative, or never drops back to 0."** Fixed in 2.6: the gauge now counts per request (a request answered by an earlier pre-hook is never uncounted) and every adapter runs the after-hooks for `sse()` streams and abandoned responses.

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
