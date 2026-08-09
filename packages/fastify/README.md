# @basaltkit/fastify

Official Basalt adapter for [Fastify](https://fastify.dev): takes Basalt's typed routes and serves them on a Fastify server, with per-request context, standardized errors and an idempotency plugin. You need this when you want to build an HTTP API in Node.js with Basalt using Fastify as the engine.

## What this module solves

An HTTP server is the program that receives **HTTP requests** (the messages a browser or an app sends, like "give me user 42") and returns responses. [Fastify](https://fastify.dev) is one of the fastest servers in the Node.js ecosystem — but, on its own, it doesn't validate data, doesn't type the handlers, and every project invents its own error format.

This module connects Fastify to Basalt. You define each **route** (an address + method, e.g. `POST /projects`) with the `route()` function and [Zod](https://zod.dev) schemas; the adapter handles the rest: it validates the body, query and URL parameters, creates a per-request context (with `requestId` accessible anywhere in the code, even in deeply nested functions, via `ctx()`), and converts errors into JSON responses with a stable format — never exposing internal messages on a `500`.

Since route definitions are neutral (they come from `@basaltkit/http`), the same route code also runs on the Express and Hono adapters. And the edge plugins (security, health, metrics, tracing, OpenAPI) are re-exported here for convenience. The extra piece exclusive to this adapter is `idempotencyPlugin`: safe retries of requests that mutate data (e.g. never charging a card twice).

## Installation

```bash
pnpm add @basaltkit/fastify @basaltkit/core zod
```

Fastify already comes as a dependency of this package — you don't need to install it separately. `zod` (version 3 or 4) is a *peer dependency*.

## Getting started in 5 minutes

**Step 1** — install the packages (command above).

**Step 2** — create a `server.ts` file with a route and the server startup:

```ts
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route } from '@basaltkit/fastify'
import { z } from 'zod'

// 1. Define the route: method, URL, validation and handler (the function that responds).
const createProject = route({
  method: 'POST',
  url: '/projects',
  body: z.object({ name: z.string().min(3) }), // the body must have a name with 3+ letters
  async handler({ body, reply }) {
    // body.name is already validated and typed as string
    return reply.code(201).send({ id: 'p1', name: body.name })
  },
})

// 2. Create the Basalt app with the Fastify plugin and start it.
const app = await createApp({ plugins: [fastifyPlugin({ routes: [createProject] })] }).boot()

// 3. Get the Fastify instance from the container and start listening on a port.
await app.container.get(FASTIFY).listen({ port: 3000 })
console.log('Listening on http://localhost:3000')
```

**Step 3** — run and test:

```bash
npx tsx server.ts
curl -X POST http://localhost:3000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Basalt"}'
# → {"id":"p1","name":"Basalt"}   (status 201)

curl -X POST http://localhost:3000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"ab"}'
# → 400 {"error":{"code":"HTTP_VALIDATION","part":"body","issues":[...]}}
```

**Step 4** — for a clean shutdown (closes Fastify): `await app.shutdown()`.

## Usage guide

### Typed routes with params, query and errors

```ts
import { HttpError, route } from '@basaltkit/fastify'
import { z } from 'zod'

const getProject = route({
  method: 'GET',
  url: '/projects/:id', // :id is a dynamic parameter
  params: z.object({ id: z.string() }),
  // In the query string everything arrives as text; z.coerce converts it
  query: z.object({ expand: z.coerce.boolean().default(false) }),
  async handler({ params, query }) {
    if (params.id === 'missing') {
      // Intentional error: becomes a 404 with a stable code
      throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
    }
    return { id: params.id, expand: query.expand }
  },
})
```

Unintentional errors (`throw new Error('secret')`) respond with `500` and `INTERNAL_ERROR` — the internal message is logged in Fastify's log, but never sent to the client.

### Per-request context (`ctx()`)

Each request runs inside a context (via Node's `AsyncLocalStorage`): in any function, no matter how deeply nested, you can read the `requestId` without passing it down as an argument.

```ts
import { createApp, ctx } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'

async function deepService(): Promise<string> {
  return ctx().requestId as string // the same id as the current request
}

const whoami = route({
  method: 'GET',
  url: '/whoami',
  async handler() {
    return { requestId: ctx().requestId, viaService: await deepService() }
  },
})
```

If the client sends the `x-request-id` header, that value is used; otherwise a UUID is generated. The response always returns `x-request-id`. Each request also gets its own dependency container *scope* (`ctx().container`) — instances registered as `scoped` are new per request.

### Idempotency — `idempotencyPlugin()` (Fastify-exclusive)

Idempotency means: repeating the same request doesn't repeat its effect. When the client sends the `Idempotency-Key` header, the first response is stored; any repeat with the same key receives **the same response**, without running the handler again — a network retry never charges a card twice.

```ts
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, idempotencyPlugin, route } from '@basaltkit/fastify'
import { z } from 'zod'

const charge = route({
  method: 'POST',
  url: '/charge',
  body: z.object({ amount: z.number() }),
  async handler({ body, reply }) {
    return reply.code(201).send({ charged: body.amount })
  },
})

const app = await createApp({
  plugins: [fastifyPlugin({ routes: [charge] }), idempotencyPlugin()],
}).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
```

```bash
curl -X POST http://localhost:3000/charge \
  -H 'content-type: application/json' \
  -H 'idempotency-key: abc-123' \
  -d '{"amount":10}'
# Repeat the same command: same response, with the Idempotent-Replayed: true header
```

Rules (verified in the package's tests):
- A repeat while the first request is still in flight → `409 IDEMPOTENCY_CONFLICT`.
- Responses `>= 500` are **not** stored — genuine failures can still be retried.
- Keys are isolated by method + route: the same key on two endpoints doesn't collide.
- Requests without the header are unaffected.

### Edge plugins (security, health, metrics, tracing, OpenAPI)

They're neutral (they live in `@basaltkit/http`) but re-exported here — you can import everything from `@basaltkit/fastify`:

```ts
import { createApp } from '@basaltkit/core'
import {
  FASTIFY,
  fastifyPlugin,
  healthPlugin,
  metricsPlugin,
  openapiPlugin,
  route,
  securityPlugin,
  tracingPlugin,
} from '@basaltkit/fastify'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [ping] }),
    securityPlugin({ cors: { origin: ['https://app.example.com'] }, rateLimit: { limit: 100, windowMs: 60_000 } }),
    healthPlugin({ checks: { db: () => ({ ok: true }) } }), // GET /livez and /readyz
    metricsPlugin(),                                        // GET /metrics (Prometheus)
    tracingPlugin({ serviceName: 'my-api' }),                // spans + traceparent header
    openapiPlugin({ info: { title: 'My API', version: '1.0.0' } }), // GET /openapi.json
  ],
}).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
```

Detailed documentation for each one (all options) is in the [`@basaltkit/http`](../http/README.md) README.

### Advanced: `registerRoutes()` without the plugin

If you already have a Fastify server and just want to mount Basalt routes on it:

```ts
import Fastify from 'fastify'
import { registerRoutes, route } from '@basaltkit/fastify'

const instance = Fastify()
const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })
registerRoutes(instance, [ping]) // container, enrichers and guards are optional
await instance.listen({ port: 3000 })
```

Note: without the plugin there's no standardized error handling (`setErrorHandler` is installed by `fastifyPlugin`), no edge plugins, and routes aren't registered for OpenAPI/CLI.

### Fastify options (logger, trustProxy, …)

```ts
fastifyPlugin({
  routes,
  fastify: { logger: true, trustProxy: true }, // passed as-is to the Fastify() constructor
})
```

## API reference

### `fastifyPlugin(options?)` → Basalt plugin (`basalt:fastify`)

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `routes` | `BasaltRoute[]` | No | `[]` | Routes (created with `route()`) to register. |
| `fastify` | `FastifyServerOptions` | No | `{}` | Options passed to the `Fastify()` constructor (logger, trustProxy, …). |

Behavior: registers the Fastify instance under the `FASTIFY` token and an `HttpServerCollector` under the `HTTP_SERVER` token; on boot it reads enrichers/guards from the metadata buckets (`'http:enrichers'`, `'http:guards'`), registers the routes, publishes them on the `'http:routes'` bucket (for OpenAPI/CLI/SDK) and mounts the edge plugins' hooks on the `app:booted` event. On `shutdown` it closes Fastify (`close()`).

### `FASTIFY`

Dependency injection token (`Token<FastifyInstance>`): `app.container.get(FASTIFY)` returns the Fastify instance for `listen()`, `inject()` (tests) or extra configuration.

### `registerRoutes(instance, routes, container?, enrichers?, guards?)`

| Parameter | Type | Required? | Default | Description |
|---|---|---|---|---|
| `instance` | `FastifyInstance` | Yes | — | Fastify server to mount on. |
| `routes` | `BasaltRoute[]` | Yes | — | Routes to mount. |
| `container` | `Container` | No | — | DI container; without it there's no per-request scope or enrichers/guards. |
| `enrichers` | `RequestEnricher[]` | No | `[]` | Functions that enrich the context before the guards. |
| `guards` | `RouteGuard[]` | No | `[]` | Functions that can reject the request (by throwing an error). |

### `idempotencyPlugin(options?)` → Basalt plugin (`basalt:idempotency`, depends on `basalt:fastify`)

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `store` | `IdempotencyStore` | No | `new MemoryIdempotencyStore(ttlMs)` | Where to store responses. |
| `header` | `string` | No | `'idempotency-key'` | Header carrying the key. |
| `methods` | `string[]` | No | `['POST']` | Protected methods. |
| `ttlMs` | `number` | No | `86_400_000` (24 h) | Retention time for each record. |

`IdempotencyStore` (interface): `get(key)` → `IdempotencyRecord | 'pending' | undefined`; `setPending(key)`; `complete(key, record)`; `release(key)`. `IdempotencyRecord` = `{ status: number; body: string; contentType?: string }`. `MemoryIdempotencyStore(ttlMs?, clock?)` is the in-memory implementation; for a cluster, implement the interface over Redis.

### Re-exports from `@basaltkit/http`

For convenience (and backward compatibility), this package re-exports: `route`, `HttpError`, `RequestValidationError`, `securityPlugin`, `MemoryRateLimitStore`, `healthPlugin`, `metricsPlugin` + `METRICS`, `tracingPlugin` + `TRACER`, `openapiPlugin`, `generateOpenApi`, `zodToJsonSchema`, `HTTP_SERVER` and the associated types (`BasaltRoute`, `HandlerArgs`, `HttpMethod`, `HttpRequest`, `HttpReply`, `ValidationIssue`, `RequestEnricher`, `RouteGuard`, plugin options, …). See the `@basaltkit/http` README for the option tables.

## Common errors and solutions (FAQ)

**"`app.container.get(FASTIFY)` fails."** Only works after `boot()`: `const app = await createApp({...}).boot()`. Also confirm that `fastifyPlugin` is in the `plugins` list.

**"I get a 400 `HTTP_VALIDATION` on a GET with query."** In the query string everything arrives as text (`"true"`, `"42"`). Use `z.coerce.boolean()` / `z.coerce.number()` in the schema.

**"The body arrives as `undefined`."** The client must send `Content-Type: application/json`; without that header Fastify doesn't parse the JSON.

**"idempotencyPlugin throws an error on boot."** It declares `dependsOn: ['basalt:fastify']` — it needs `fastifyPlugin` registered in the same app.

**"The edge plugins (metrics, health, …) don't respond."** Their hooks/routes are mounted on the `app:booted` event — make sure you call `boot()` and that `fastifyPlugin` is present (it's the one that registers `HTTP_SERVER`).

**"How do I test without opening a port?"** Use Fastify's `inject()`: `await app.container.get(FASTIFY).inject({ method: 'GET', url: '/ping' })` — that's how this package's own tests work.

## How it connects to other modules

- **`@basaltkit/core`** — `fastifyPlugin` is a Basalt plugin (`definePlugin`): it lives in the `createApp → boot → shutdown` lifecycle, uses the `Container` (tokens `FASTIFY` and `HTTP_SERVER`) and creates the per-request `RequestContext` that feeds `ctx()`/`tryCtx()`.
- **`@basaltkit/http`** — the entire pipeline (validation, enrichers, guards, error mapping) comes from here; this adapter only converts Fastify's request/response into the neutral format and calls `runRoute()`. Routes defined with `route()` run unchanged on the Express and Hono adapters.
- **`@basaltkit/auth` / `@basaltkit/tenancy` / `@basaltkit/permissions`** — register guards and enrichers on the `'http:guards'`/`'http:enrichers'` buckets, which this adapter applies to all routes; they read the route's `meta` (e.g. `meta: { auth: true }`).
- **`@basaltkit/sdk` and the CLI (`basalt routes`)** — read the routes published on the `'http:routes'` bucket (with the Zod schemas) to generate clients and documentation, with no duplicated configuration.
