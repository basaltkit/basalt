# @machize/express

Machize adapter for [Express](https://expressjs.com): the same typed routes, enrichers, and guards you'd use in Fastify or Hono, running on an Express server. You need it when you already use Express (or want its huge middleware ecosystem) and want Machize's validation, per-request context, and standardized errors.

## What this module solves

[Express](https://expressjs.com) is Node.js's best-known HTTP server — the program that receives **HTTP requests** (messages like "create this project") and returns responses. But Express, by itself, doesn't validate data, doesn't type anything in TypeScript, and every project invents its own error format.

This module connects Express to Machize. **Routes** (address + method, e.g. `POST /echo`) are defined with the `route()` function from `@machize/http`, in a neutral format with [Zod](https://zod.dev) schemas for validation. The adapter converts each Express request into that neutral format, runs the shared pipeline (validation, *enrichers* — functions that enrich the request context, like resolving the tenant — and *guards* — functions that can reject the request, like authentication), and converts errors into JSON responses with a stable format.

The strong point: **portability**. A route written for this adapter runs unchanged on `@machize/fastify` and `@machize/hono`. And the neutral edge plugins (security, health, metrics, tracing, OpenAPI) from `@machize/http` work here exactly the same.

## Installation

```bash
pnpm add @machize/express @machize/core @machize/http express zod
```

`express` (version 4.19+ or 5) is a peer dependency — install it yourself. `zod` is required for the route schemas.

## Get started in 5 minutes

**Step 1** — install the packages (command above).

**Step 2** — create a `server.ts` file:

```ts
import { createApp } from '@machize/core'
import { route } from '@machize/http'
import { EXPRESS, expressPlugin } from '@machize/express'
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

// 2. Create the Machize app with the Express plugin and start it.
const app = await createApp({ plugins: [expressPlugin({ routes: [echo] })] }).boot()

// 3. Get the Express app from the container and have it listen on a port.
app.container.get(EXPRESS).listen(3000)
console.log('Listening on http://localhost:3000')
```

**Step 3** — run and test:

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

> The plugin already enables `express.json()` for you — you don't need to configure JSON parsing.

## Usage guide

### Routes with params, query, and errors

```ts
import { HttpError, route } from '@machize/http'
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
    // Intentional error: turns into a 418 response with a stable code
    throw new HttpError(418, 'TEAPOT', "I'm a teapot")
  },
})
```

The error format is identical to the other adapters: `{ error: { code, message, ... } }`. Unexpected errors respond with `500` and `INTERNAL_ERROR`, without exposing internal details.

### Enrichers and guards (authentication, tenancy, …)

Plugins register these functions in the container's metadata "buckets"; the adapter applies them to every route. Real example (from the package's tests) — a tenancy-style enricher and an auth-style guard:

```ts
import { createApp, definePlugin, ensureMetadata, tryCtx } from '@machize/core'
import { HttpError, route, type RequestEnricher, type RouteGuard } from '@machize/http'
import { EXPRESS, expressPlugin } from '@machize/express'
import { z } from 'zod'

// Enricher: runs before everything else and attaches the tenant to the request context.
const enricher: RequestEnricher = ({ request, context }) => {
  const tenant = request.headers['x-tenant-id']
  if (typeof tenant === 'string') (context as { tenant?: unknown }).tenant = { id: tenant }
}

// Guard: rejects the request by throwing an error. Reads the route's meta.
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

const app = await createApp({ plugins: [myPlugin, expressPlugin({ routes: [secure] })] }).boot()
app.container.get(EXPRESS).listen(3000)
```

Without `Authorization` → `401 AUTH_REQUIRED`; with the `x-tenant-id: acme` header the handler sees `tenant: 'acme'` via context.

### Neutral edge plugins

Imported from `@machize/http` and work on Express without changes:

```ts
import { createApp } from '@machize/core'
import { healthPlugin, metricsPlugin, route, securityPlugin } from '@machize/http'
import { EXPRESS, expressPlugin } from '@machize/express'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

const app = await createApp({
  plugins: [
    expressPlugin({ routes: [ping] }),
    securityPlugin({ rateLimit: { limit: 100, windowMs: 60_000 } }), // secure headers + 429 above the limit
    healthPlugin({ checks: { db: () => ({ ok: true }) } }),          // GET /livez and /readyz
    metricsPlugin(),                                                  // GET /metrics (Prometheus)
  ],
}).boot()
app.container.get(EXPRESS).listen(3000)
```

All the options for these plugins are documented in the [`@machize/http`](../http/README.md) README.

### Bring your own Express app

If you already have an Express app with your own middleware, pass it to the plugin:

```ts
import express from 'express'
import { expressPlugin } from '@machize/express'

const myApp = express()
// ... your middleware here ...
expressPlugin({ app: myApp, routes: [] })
// Note: the plugin still adds express.json().
```

### Advanced: `registerRoutes()` without the plugin

Mount Machize routes on an Express app directly, without the Machize lifecycle:

```ts
import express from 'express'
import { route } from '@machize/http'
import { registerRoutes } from '@machize/express'

const app = express()
app.use(express.json()) // without the plugin, JSON parsing is your responsibility
const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })
registerRoutes(app, [ping]) // container, enrichers, and guards are optional
app.listen(3000)
```

In this mode each handler already handles its own errors (the wrapper responds with `toErrorResponse`), but there are no edge plugins or route registration for OpenAPI/CLI.

## API reference

### `expressPlugin(options?)` → Machize plugin (`machize:express`)

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `routes` | `MachizeRoute[]` | No | `[]` | Routes (created with `route()` from `@machize/http`) to mount. |
| `app` | `Express` | No | new `express()` | Bring your own Express app; either way, `express.json()` is added. |

Behavior: registers the Express app under the `EXPRESS` token and an `HttpServerCollector` under the `HTTP_SERVER` token. On the `app:booted` event it mounts everything in the order Express requires: *after-hooks* middleware (metrics/tracing, via `res.on('finish')`) → *pre-hooks* middleware (security/CORS/rate limit; if one of them responds, the route doesn't run) → Machize routes → extra routes from edge plugins (`/livez`, `/metrics`, …). Publishes the routes in the `'http:routes'` metadata bucket for OpenAPI/CLI/SDK.

> Note: unlike `fastifyPlugin`, this plugin has no `shutdown` step — closing the HTTP server returned by `listen()` is your responsibility.

### `EXPRESS`

Dependency-injection token (`Token<Express>`): `app.container.get(EXPRESS)` returns the Express app so you can call `listen(port)` or add middleware.

### `registerRoutes(app, routes, container?, enrichers?, guards?)`

| Parameter | Type | Required? | Default | Description |
|---|---|---|---|---|
| `app` | `Express` | Yes | — | Express app to mount on. |
| `routes` | `MachizeRoute[]` | Yes | — | Routes to mount. |
| `container` | `Container` | No | — | DI container; without it there's no per-request scope or enrichers/guards. |
| `enrichers` | `RequestEnricher[]` | No | `[]` | Functions that enrich the context before the guards. |
| `guards` | `RouteGuard[]` | No | `[]` | Functions that can reject the request (by throwing an error). |

### What to import from where

This package only exports `expressPlugin`, `registerRoutes`, `EXPRESS`, and `ExpressPluginOptions`. Everything else — `route`, `HttpError`, `RequestValidationError`, `securityPlugin`, `healthPlugin`, `metricsPlugin`, `tracingPlugin`, `openapiPlugin`, types like `RequestEnricher`/`RouteGuard` — is imported from **`@machize/http`**.

## Common errors and solutions (FAQ)

**"`Cannot find module 'express'`."** Express is a peer dependency: `pnpm add express`.

**"`body` arrives `undefined` in the handler."** The client has to send the `Content-Type: application/json` header; without it `express.json()` won't parse the body.

**"I tried `import { route } from '@machize/express'` and it failed."** The `route()` function isn't exported from this package — import it from `@machize/http` (it's neutral on purpose: the same route runs on Fastify and Hono).

**"400 `HTTP_VALIDATION` on a GET with a correct query."** In Express's query everything arrives as text — use `z.coerce.number()` / `z.coerce.boolean()` in your schemas.

**"The edge plugins don't respond (`/metrics` gives 404)."** They're mounted on the `app:booted` event: make sure you call `await createApp({...}).boot()` before `listen()` and that `expressPlugin` is in the plugin list (it's the one that registers `HTTP_SERVER`).

**"How do I close the server in a test?"** Keep the return value of `listen()`: `const server = app.container.get(EXPRESS).listen(0)` and at the end `server.close()` followed by `await app.shutdown()`.

## How it connects to other modules

- **`@machize/core`** — `expressPlugin` is a Machize plugin (`definePlugin`) in the `createApp → boot` lifecycle; it uses the `Container` (tokens `EXPRESS`, `HTTP_SERVER`), the metadata buckets, and the per-request context (`ctx()`/`tryCtx()`), available at any depth of the code.
- **`@machize/http`** — provides `route()`, the `runRoute()` pipeline (validation, enrichers, guards), `toErrorResponse()`, and the edge plugins. This adapter simply converts Express's `Request`/`Response` into the neutral `HttpRequest`/`HttpReply`.
- **`@machize/fastify` / `@machize/hono`** — sibling adapters: the same routes, enrichers, guards, and edge plugins run on any of them unchanged; switching frameworks is just switching plugins.
- **`@machize/auth` / `@machize/tenancy` / `@machize/permissions`** — register guards/enrichers in `'http:guards'`/`'http:enrichers'` and read the routes' `meta` (e.g. `meta: { auth: true }`); this adapter applies them automatically.
- **`@machize/sdk` and the CLI** — consume the `'http:routes'` bucket (routes + Zod schemas) that this plugin publishes.
