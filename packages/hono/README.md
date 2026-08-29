<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/hono

The Basalt adapter for [Hono](https://hono.dev): the same typed routes, enrichers, and guards you'd use with Fastify or Express, running on Hono — on Node.js, Bun, Deno, or *edge* platforms (Cloudflare Workers, Vercel Edge, …). You need this when you want to take your Basalt API outside classic Node, or when you're already using Hono.

## What this module solves

[Hono](https://hono.dev) is a small, very fast web framework built on top of standard web APIs (`fetch`'s `Request`/`Response`). Because of that, it runs almost everywhere: Node.js, Bun, Deno, and *edge runtimes* — servers that execute your code in hundreds of locations close to users. But, like other frameworks, Hono on its own doesn't validate data or standardize errors.

This module connects Hono to Basalt. **Routes** (a path + HTTP method, e.g. `POST /echo`) are defined with the `route()` function from `@basaltkit/http`, with [Zod](https://zod.dev) schemas that validate the body, query, and URL parameters — and give you TypeScript types for free. The adapter converts each Hono request into Basalt's neutral format, runs the shared pipeline (validation, *enrichers* — functions that enrich the request context — and *guards* — functions that can reject it, e.g. authentication), and returns responses with errors in a stable format.

The main benefit is **portability**: a route written here runs unchanged on `@basaltkit/fastify` and `@basaltkit/express` — **the three adapters are equals**. Routes, enrichers, guards, the per-request context, standardized errors, the neutral 404, ETags (`meta.etag`), SSE, per-route rate limits and the boot-time guarded-meta check all behave identically. The neutral edge plugins (security, health, metrics, tracing, OpenAPI) from `@basaltkit/http` work on Hono exactly the same way.

## Installation

```bash
pnpm add @basaltkit/hono @basaltkit/core @basaltkit/http hono zod
```

`hono` (version 4+) is a *peer dependency* — you install it. To serve on Node.js you also need `pnpm add @hono/node-server`; on Bun, Deno, or edge nothing extra is needed.

## Get started in 5 minutes

**Step 1** — install the packages (command above, plus `@hono/node-server` if you're on Node).

**Step 2** — create a `server.ts` file:

```ts
import { serve } from '@hono/node-server'
import { createApp } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { HONO, honoPlugin } from '@basaltkit/hono'
import { z } from 'zod'

// 1. Define a route: method, URL, validation, and handler (the function that responds).
const echo = route({
  method: 'POST',
  url: '/echo',
  body: z.object({ n: z.number() }), // the body must have a number n
  async handler({ body, reply }) {
    // body.n is already validated and typed as number
    return reply.code(201).send({ doubled: body.n * 2 })
  },
})

// 2. Create the Basalt app with the Hono plugin and boot it.
const app = await createApp({ plugins: [honoPlugin({ routes: [echo] })] }).boot()

// 3. Get the Hono app from the container and serve it on Node.
serve({ fetch: app.container.get(HONO).fetch, port: 3000 })
console.log('Listening on http://localhost:3000')
```

**Step 3** — run it and test:

```bash
npx tsx server.ts
curl -X POST http://localhost:3000/echo \
  -H 'content-type: application/json' \
  -d '{"n":21}'
# → {"doubled":42}   (status 201)

curl -X POST http://localhost:3000/echo \
  -H 'content-type: application/json' \
  -d '{"n":"nope"}'
# → 400 {"error":{"code":"HTTP_VALIDATION","part":"body","issues":[...]}}
```

**On an edge runtime** (Cloudflare Workers, Bun, Deno) you export `fetch` instead of calling `serve`:

```ts
const app = await createApp({ plugins: [honoPlugin({ routes: [echo] })] }).boot()
export default app.container.get(HONO) // the runtime calls .fetch for you
```

## Usage guide

### Routes with params, query, and errors

```ts
import { HttpError, route } from '@basaltkit/http'
import { z } from 'zod'

const hello = route({
  method: 'GET',
  url: '/hello/:name', // :name is a dynamic URL parameter
  params: z.object({ name: z.string() }),
  async handler({ params }) {
    return { hello: params.name }
  },
})

const boom = route({
  method: 'GET',
  url: '/boom',
  async handler() {
    // Intentional error: becomes a 418 response with a stable code
    throw new HttpError(418, 'TEAPOT', "I'm a teapot")
  },
})
```

Unexpected errors respond with `500` and `{ error: { code: 'INTERNAL_ERROR', ... } }` — the same format as the other adapters, without exposing internal details.

### Request body: what the adapter interprets

The adapter reads the body based on `Content-Type`: `application/json` → JSON object; forms (`form`) → Hono's `parseBody()`; other text → string; empty or invalid body → `undefined` (Zod validation handles the rest). `GET`/`HEAD` requests never have a body.

### Body-size limit — `bodyLimit`

Hono and edge runtimes impose **no** default cap on a request body, so an upload is
unbounded unless something stops it. The plugin installs a guard that rejects any request
whose `Content-Length` exceeds the limit with `413` and
`{ code: 'PAYLOAD_TOO_LARGE', message: … }` — **before the body is read**.

```ts
import { DEFAULT_BODY_LIMIT, honoPlugin } from '@basaltkit/hono'

honoPlugin({ routes, bodyLimit: 5 * 1024 * 1024 }) // 5 MiB
DEFAULT_BODY_LIMIT // 1_048_576 — 1 MiB, the default
```

> Note this checks the declared `Content-Length`; it is a cheap first line of defence, not
> a streaming byte counter.

### Guarded route meta — the boot check

If a route declares `meta.auth`, `meta.can` or `meta.teamRole` and **no registered plugin
enforces that key**, the route would serve unprotected. `honoPlugin` refuses to boot: it
calls `assertRoutesGuarded()` in its boot phase and throws `UnguardedRouteMetaError`
(code `HTTP_UNGUARDED_ROUTE_META`), naming every offending route and key, before a single
request is served.

Fix it by registering the enforcing plugin (`auth` → `authPlugin`, `can` →
`permissionsPlugin`, `teamRole` → `teamsPlugin`). If protection really does happen at an
outer edge (a Worker in front, a gateway), waive it explicitly:

```ts
honoPlugin({ routes, allowUnguardedMeta: true })      // waive every key
honoPlugin({ routes, allowUnguardedMeta: ['auth'] })  // waive one key
```

Fastify and Express run the identical check with the identical option.

### The neutral 404

Unmatched routes get the same JSON body on every adapter —
`{ "error": { "code": "NOT_FOUND", "message": "Route not found." } }` (`NOT_FOUND_RESPONSE`
from `@basaltkit/http`) — instead of Hono's plain-text default. An app that calls
`hono.notFound(…)` *later* still wins (Hono keeps the last handler); pass `notFound: false`
to opt out entirely.

### Streaming — SSE

A handler returning `sse(producer)` from `@basaltkit/http` becomes a `Response` backed by a
web `ReadableStream`, so it streams on Node, Bun, Deno and edge alike. Client aborts
(`request.signal`) are relayed to `stream.onClose()`. Same handler code as on Fastify and
Express.

### Enrichers and guards (authentication, tenancy, …)

Plugins register these functions in the container's metadata "buckets"; the adapter applies them to every route. Real example (from the package's tests):

```ts
import { createApp, definePlugin, ensureMetadata, tryCtx } from '@basaltkit/core'
import { HttpError, route, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import { HONO, honoPlugin } from '@basaltkit/hono'

// Enricher: attaches the tenant to the request context.
const enricher: RequestEnricher = ({ request, context }) => {
  const tenant = request.headers['x-tenant-id']
  if (typeof tenant === 'string') (context as { tenant?: unknown }).tenant = { id: tenant }
}

// Guard: rejects the request by throwing an error; reads the route's meta.
const guard: RouteGuard = ({ route: def, request }) => {
  if (def.meta?.['auth'] && !request.headers['authorization']) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required.')
  }
}

const myPlugin = definePlugin({
  name: 'my:http',
  register({ container }) {
    const metadata = ensureMetadata(container)
    metadata.add('http:enrichers', enricher)
    metadata.add('http:guards', guard)
  },
})

const secure = route({
  method: 'GET',
  url: '/secure',
  meta: { auth: true }, // the guard reads this
  async handler() {
    const tenant = (tryCtx() as { tenant?: { id: string } })?.tenant?.id ?? null
    return { ok: true, tenant }
  },
})

const app = await createApp({ plugins: [myPlugin, honoPlugin({ routes: [secure] })] }).boot()
```

Without `Authorization` → `401 AUTH_REQUIRED`; with `x-tenant-id: acme` the handler sees `tenant: 'acme'` through the request context.

### Neutral edge plugins

Imported from `@basaltkit/http` and work on Hono without changes:

```ts
import { createApp } from '@basaltkit/core'
import { healthPlugin, metricsPlugin, route, securityPlugin } from '@basaltkit/http'
import { HONO, honoPlugin } from '@basaltkit/hono'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

const app = await createApp({
  plugins: [
    honoPlugin({ routes: [ping] }),
    securityPlugin({ rateLimit: { limit: 100, windowMs: 60_000 } }), // secure headers + 429 above limit
    healthPlugin({ checks: { db: () => ({ ok: true }) } }),          // GET /livez and /readyz
    metricsPlugin(),                                                  // GET /metrics (Prometheus)
  ],
}).boot()
```

All options for these plugins are documented in the [`@basaltkit/http`](../http/README.md) README.

> On distributed edge runtimes, remember that in-memory stores (rate limit, metrics) live per instance — use shared stores (e.g. Redis/KV) when you need global values.

### Testing without opening ports

Since Hono speaks `fetch`, testing means calling `hono.fetch` with a normal `Request` — that's how this package's own tests work:

```ts
import { createApp } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { HONO, honoPlugin } from '@basaltkit/hono'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })
const app = await createApp({ plugins: [honoPlugin({ routes: [ping] })] }).boot()
const hono = app.container.get(HONO)

const res = await hono.fetch(new Request('http://local/ping'))
console.log(res.status, await res.json()) // 200 { pong: true }
await app.shutdown()
```

### Advanced: `registerRoutes()` without the plugin

Mount Basalt routes onto an existing Hono app, without the Basalt lifecycle:

```ts
import { Hono } from 'hono'
import { route } from '@basaltkit/http'
import { registerRoutes } from '@basaltkit/hono'

const app = new Hono()
const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })
registerRoutes(app, [ping]) // container, enrichers, and guards are optional
export default app
```

In this mode errors are still standardized (each handler wraps `toErrorResponse`), but there are no edge plugins and no route registration for OpenAPI/CLI.

## API reference

### `honoPlugin(options?)` → Basalt plugin (`basalt:hono`)

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `routes` | `BasaltRoute[]` | No | `[]` | Routes (created with `route()` from `@basaltkit/http`) to mount. |
| `allowUnguardedMeta` | `boolean \| string[]` | No | fail loud at boot | Waives the boot check that every route declaring security meta (`auth`, `can`, `teamRole`) has a registered guard enforcing it (`UnguardedRouteMetaError` otherwise). `true` waives everything (edge/gateway auth); an array waives specific keys. |
| `app` | `Hono` | No | `new Hono()` | Bring your own Hono app; otherwise a new one is created. |
| `notFound` | `boolean` | No | `true` | Serve `NOT_FOUND_RESPONSE` (the neutral JSON 404) for unmatched routes. A later `hono.notFound(…)` of your own still wins; `false` opts out entirely. |
| `bodyLimit` | `number` | No | `DEFAULT_BODY_LIMIT` = `1_048_576` (1 MiB) | Maximum request body in bytes. A request whose `Content-Length` exceeds it is rejected `413 PAYLOAD_TOO_LARGE` before the body is read — Hono/edge has no default cap of its own. |

Behavior: registers the Hono app on the `HONO` token and an `HttpServerCollector` on the `HTTP_SERVER` token. On the `app:booted` event it mounts, in order: *after-hooks* middleware (metrics/tracing, measuring duration), *pre-hooks* middleware (security/CORS/rate limit; if one of these responds, the route doesn't run), the Basalt routes, and the extra edge plugin routes (`/livez`, `/metrics`, `/openapi.json`, …). Publishes the routes to the `'http:routes'` metadata bucket for OpenAPI/CLI/SDK.

> Note: this plugin has no `shutdown` step of its own — Basalt never starts a listener for you, so stopping the server (`serve` from `@hono/node-server`, etc.) is your responsibility.

### `DEFAULT_BODY_LIMIT`

`1_048_576` (1 MiB) — the default for `honoPlugin({ bodyLimit })`, exported so you can
reason about it or reuse it.

### Errors

| Error | Code | HTTP | When |
|---|---|---|---|
| `RequestValidationError` | `HTTP_VALIDATION` | 400 | `body`/`query`/`params` failed its Zod schema. Response carries `part` + `issues[]`. |
| `HttpError(status, code, message)` | *yours* | *yours* | Thrown deliberately from any layer. |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | — (boot) | A route declares a guarded key (`auth`/`can`/`teamRole`/`scopes`/`subscribed`/`feature`) with no guard enforcing it. Waive with `allowUnguardedMeta`. |
| — | `NOT_FOUND` | 404 | No route matched (unless `notFound: false`). |
| — | `PAYLOAD_TOO_LARGE` | 413 | Declared `Content-Length` exceeds `bodyLimit`. Body shape here is flat (`{ code, message }`), not the nested `{ error: … }` envelope. |
| — | `RATE_LIMITED` | 429 | `securityPlugin`'s limiter rejected the request. |
| — | `INTERNAL_ERROR` | 500 | Any other thrown error. The real message never reaches the client. |

### `HONO`

Dependency injection token (`Token<Hono>`): `app.container.get(HONO)` returns the Hono app — use `hono.fetch` to serve (on Node via `@hono/node-server`, or export it in an edge runtime) and for testing.

### `registerRoutes(app, routes, container?, enrichers?, guards?)`

| Parameter | Type | Required? | Default | Description |
|---|---|---|---|---|
| `app` | `Hono` | Yes | — | Hono app to mount onto. |
| `routes` | `BasaltRoute[]` | Yes | — | Routes to mount (via `app.on(method, url, handler)`). |
| `container` | `Container` | No | — | DI container; without it there's no per-request scope or enrichers/guards. |
| `enrichers` | `RequestEnricher[]` | No | `[]` | Functions that enrich the context before the guards. |
| `guards` | `RouteGuard[]` | No | `[]` | Functions that can reject the request (by throwing an error). |

### What to import from where

This package exports `honoPlugin`, `registerRoutes`, `HONO`, `DEFAULT_BODY_LIMIT`, and `HonoPluginOptions`. Everything else — `route`, `HttpError`, `RequestValidationError`, `NOT_FOUND_RESPONSE`, `sse`, `securityPlugin`, `RedisRateLimitStore`, `healthPlugin`, `metricsPlugin`, `tracingPlugin`, `openapiPlugin`, `escapeHtml`/`pageCsp`, types like `RequestEnricher`/`RouteGuard` — is imported from **`@basaltkit/http`**. (Unlike `@basaltkit/fastify`, this package re-exports nothing; that is a naming choice, not a capability gap.)

## Common errors and solutions (FAQ)

**"`Cannot find module 'hono'`."** Hono is a *peer dependency*: `pnpm add hono`.

**"Nothing responds on Node."** Hono doesn't open ports on its own on Node — you need `@hono/node-server`: `serve({ fetch: hono.fetch, port: 3000 })`.

**"I tried `import { route } from '@basaltkit/hono'` and it failed."** The `route()` function isn't exported by this package — import it from `@basaltkit/http` (it's neutral by design: the same route runs on Fastify and Express).

**"`body` arrives as `undefined`."** Send the `Content-Type: application/json` header; without it the adapter doesn't parse the body as JSON. Also note that `GET`/`HEAD` never have a body.

**"400 `HTTP_VALIDATION` on a GET with a correct query."** In the query, everything arrives as text — use `z.coerce.number()` / `z.coerce.boolean()` in your schemas.

**"The edge plugins don't respond (`/metrics` returns 404)."** They're mounted on the `app:booted` event: make sure you call `await createApp({...}).boot()` before serving, and that `honoPlugin` is in the plugins list (it's the one that registers `HTTP_SERVER`).

**"The rate limit resets out of nowhere on edge."** Each edge instance has its own memory; `MemoryRateLimitStore` isn't shared across locations. Implement `RateLimitStore` on top of shared storage.

## How it connects to other modules

- **`@basaltkit/core`** — `honoPlugin` is a Basalt plugin (`definePlugin`) in the `createApp → boot` lifecycle; uses the `Container` (tokens `HONO`, `HTTP_SERVER`), the metadata buckets, and the per-request context (`ctx()`/`tryCtx()`).
- **`@basaltkit/http`** — provides `route()`, the `runRoute()` pipeline (validation, enrichers, guards), `toErrorResponse()`, and the edge plugins. This adapter converts Hono's `Context` into the neutral `HttpRequest`/`HttpReply` and turns the result into a standard web `Response`.
- **`@basaltkit/fastify` / `@basaltkit/express`** — sibling adapters: the same routes, enrichers, guards, and edge plugins run on any of them without changes; switching frameworks (or runtime — Node → edge) is just switching the plugin.
- **`@basaltkit/auth` / `@basaltkit/tenancy` / `@basaltkit/permissions`** — register guards/enrichers on `'http:guards'`/`'http:enrichers'` and read the routes' `meta` (e.g. `meta: { auth: true }`); this adapter applies them automatically.
- **`@basaltkit/sdk` and the CLI** — consume the `'http:routes'` bucket (routes + Zod schemas) that this plugin publishes.
- **`@basaltkit/testing`** — `createTestApp({ adapter: 'hono' })` runs your suite against this adapter in-process (`hono.fetch(new Request(…))`, no socket).

Guides: [Adapters](/guide/adapters) · [Testing](/guide/testing) · [Security](/guide/security) · [Production](/guide/production)
