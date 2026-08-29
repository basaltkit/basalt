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

`zod` is a *peer dependency* (the module uses it but lets you choose the version). You'll also need an adapter to serve requests, e.g. `pnpm add @basaltkit/fastify`.

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

When the limit is exceeded, the client receives `429` with the `RATE_LIMITED` code and the `Retry-After` header. The default storage is in memory (`MemoryRateLimitStore`); for multiple servers in a cluster, implement the `RateLimitStore` interface on top of Redis and pass it in `rateLimit.store`.

### Health probes — `healthPlugin()`

Creates two Kubernetes-style routes:

- `GET /livez` — "is the process alive?" Always responds `200`, without touching any dependency.
- `GET /readyz` — "is it ready to receive traffic?" Runs all checks; if any fails, responds `503` with the detail for each one.

```ts
import { healthPlugin } from '@basaltkit/http'

healthPlugin({
  checks: {
    db: async () => ({ ok: true, detail: 'connected' }),
    // If the function throws an error, it counts as { ok: false } with the error message
  },
})
```

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

Routes with `meta: { auth: true }` are marked with `bearerAuth` security in the document. The route's `response` field (schemas per status code) feeds the documented responses.

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

## API reference

### `route(config)` → `BasaltRoute`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `method` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'HEAD' \| 'OPTIONS'` | Yes | — | HTTP method. |
| `url` | `string` | Yes | — | Path, with `:name` parameters. |
| `body` | `ZodType` | No | `undefined` | Request body schema; validated at runtime. |
| `query` | `ZodType` | No | `undefined` | Query string schema; validated at runtime. |
| `params` | `ZodType` | No | `undefined` | URL parameters schema; validated at runtime. |
| `response` | `Record<number, ZodType>` | No | `undefined` | Response schemas per status — only for OpenAPI/SDK, not validated at runtime. |
| `meta` | `Record<string, unknown>` | No | `undefined` | Free-form metadata read by other plugins (e.g. `auth`, permissions). |
| `handler` | `(args) => unknown` | Yes | — | Receives `{ body, query, params, request, reply }`; the returned value is sent as the response (JSON), unless you've already responded with `reply.send()`. |

### Errors

| Export | Description |
|---|---|
| `HttpError(status, code, message)` | Intentional HTTP error, throwable from any layer; becomes a response with that `status`. |
| `RequestValidationError` | Thrown by the pipeline when validation fails; becomes `400` with `part` and `issues`. |
| `ValidationIssue` | Type `{ path: string; message: string }`. |

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

`SecurityHeadersOptions`: `hsts` (default on, `max-age=15552000; includeSubDomains`), `contentTypeOptions` (default `true` → `nosniff`), `frameOptions` (default `'DENY'`), `referrerPolicy` (default `'no-referrer'`), `crossOriginOpenerPolicy` (default `'same-origin'`), `contentSecurityPolicy` (default off).

`CorsOptions`: `origin` (`boolean | string | string[] | (origin) => boolean`; default reflects any origin), `methods` (default `GET, POST, PUT, PATCH, DELETE, OPTIONS`), `allowedHeaders`, `exposedHeaders`, `credentials`, `maxAge` (default `600`).

`RateLimitOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `limit` | `number` | Yes | — | Maximum requests per window. |
| `windowMs` | `number` | Yes | — | Window duration in milliseconds. |
| `store` | `RateLimitStore` | No | `new MemoryRateLimitStore()` | Storage for the counters. |
| `key` | `(request) => string` | No | client IP | Aggregation key (e.g. per user). |
| `skip` | `(request) => boolean` | No | — | Returns `true` to exempt the request. |

`MemoryRateLimitStore(clock?)` implements `RateLimitStore` (`hit(key, limit, windowMs)` → `RateLimitResult { allowed, limit, remaining, resetAt, retryAfterMs }`; `reset(key)`).

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

`generateOpenApi(routes, info)` returns the OpenAPI 3.0.3 document as an object. `zodToJsonSchema(schema)` (Advanced) converts a subset of Zod into JSON Schema; unknown types degrade to `{}` without throwing.

## Common errors and solutions (FAQ)

**"I defined routes but nothing responds."** `@basaltkit/http` doesn't open network ports — it needs an adapter (`@basaltkit/fastify`, `@basaltkit/express`, or `@basaltkit/hono`) to connect the routes to a real server.

**"The response is 400 with `HTTP_VALIDATION` and I sent the right data."** Check the `issues` array in the response: it indicates the field (`path`) and the reason. In `query` and `params` everything arrives as text — use `z.coerce.number()` / `z.coerce.boolean()` to convert.

**"Rate limiting doesn't work with multiple servers."** `MemoryRateLimitStore` lives in each process's memory. Implement `RateLimitStore` on top of Redis and pass it in `rateLimit.store`.

**"My custom error comes out as a generic 500."** Only `HttpError` (or a `BasaltError` with a numeric `status` property) maps to the status you chose; any other error becomes `INTERNAL_ERROR` on purpose, to avoid exposing internal details.

**"`/readyz` responds 503."** Some check returned `ok: false` or threw an error; the response body carries the detail per check in `checks`.

## Server-rendered HTML helpers

`escapeHtml` (one charset: `& < > " '`, safe in text and quoted attributes),
`scriptJson` (embed JSON in an inline `<script>` without `</script>` breakout)
and `pageCsp`/`cspHash` (route-scoped CSP with sha256-hashed inline scripts)
back the `*-ui` packages and are available for your own HTML routes.

## How it connects to other modules

- **`@basaltkit/core`** — provides the foundation this module uses: `createApp`/plugins (`definePlugin`), the dependency-injection container (`Container`, tokens), the per-request context (`ctx()`/`runWithContext`), `MetricsRegistry`, `Tracer`, and `BasaltError`.
- **`@basaltkit/fastify` / `@basaltkit/express` / `@basaltkit/hono`** — the adapters: they convert the framework's native request into the neutral `HttpRequest`/`HttpReply`, call `runRoute()`, and register an `HttpServer` on the `HTTP_SERVER` token so this module's edge plugins work on any of them without changes.
- **Feature plugins** (`@basaltkit/auth`, `@basaltkit/tenancy`, `@basaltkit/permissions`, …) — integrate through the pipeline: register *enrichers* in the `'http:enrichers'` metadata bucket and *guards* in `'http:guards'`, and read the routes' `meta` (e.g. `meta: { auth: true }`).
- **Tooling** (CLI `basalt routes`, OpenAPI, `@basaltkit/sdk`) — read the routes exposed by the adapters in the `'http:routes'` bucket, including the Zod schemas.
