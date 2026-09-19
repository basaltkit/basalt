# HTTP Adapters

Basalt is **not tied to one HTTP framework**. The route pipeline —
validation, enrichers, guards, context and error mapping — lives in a neutral
core (`@basaltkit/http`), and each framework is a thin adapter over it. Write your
routes, tenancy, auth and permissions **once**, and run them on Fastify,
Express or Hono unchanged.

| Adapter | Package | Serve with |
| --- | --- | --- |
| Fastify | `@basaltkit/fastify` | `app.container.get(FASTIFY).listen({ port })` |
| Express | `@basaltkit/express` | `app.container.get(EXPRESS).listen(port)` |
| Hono | `@basaltkit/hono` | `@hono/node-server`, Bun, Deno, or an edge `fetch` export |

## The same routes everywhere

```ts
import { route, HttpError } from '@basaltkit/http' // or from '@basaltkit/fastify'
import { z } from 'zod'

export const routes = [
  route({
    method: 'GET',
    url: '/things/:id',
    params: z.object({ id: z.string() }),
    async handler({ params }) {
      const thing = await find(params.id)
      if (!thing) throw new HttpError(404, 'THING_NOT_FOUND', 'Not found')
      return thing
    },
  }),
]
```

Pick an adapter — everything else (tenancy resolvers, auth guards, permissions,
Zod validation, the standardized error shape) behaves identically:

::: code-group

```ts [Fastify]
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'

const app = await createApp({ plugins: [/* … */, fastifyPlugin({ routes })] }).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
```

```ts [Express]
import { expressPlugin, EXPRESS } from '@basaltkit/express'

const app = await createApp({ plugins: [/* … */, expressPlugin({ routes })] }).boot()
app.container.get(EXPRESS).listen(3000)
```

```ts [Hono]
import { honoPlugin, HONO } from '@basaltkit/hono'
import { serve } from '@hono/node-server'

const app = await createApp({ plugins: [/* … */, honoPlugin({ routes })] }).boot()
serve({ fetch: app.container.get(HONO).fetch, port: 3000 })
```

:::

## Live example — the playground

The repo's [`apps/playground`](https://github.com/basaltkit/basalt/tree/main/apps/playground)
is the same neutral `route()` list (a small Projects CRUD + multi-tenancy)
served on **all three** adapters. Only the last line of `buildApp()` changes —
pick the runtime with an env var:

```bash
pnpm --filter playground dev               # fastify (default)
ADAPTER=express pnpm --filter playground dev
ADAPTER=hono    pnpm --filter playground dev
```

Its `tests/adapters.e2e.test.ts` runs the identical flow over a real socket on
Fastify, Express and Hono — the executable proof that routes are runtime-neutral.

## Complete example — Fastify

Install the adapter and Fastify:

```bash
pnpm add @basaltkit/core @basaltkit/fastify fastify @basaltkit/tenancy @basaltkit/auth @basaltkit/permissions zod
```

Routes are typed from their Zod schemas and protected declaratively through
`meta`. **Enrichers** run first (tenancy resolves the tenant, auth reads the
`Authorization: Bearer` token into `ctx().user`); then **guards** run
(`meta: { auth: true }` demands a user, `meta: { can: '…' }` demands a
permission). A guard rejects by throwing — you never write that check by hand.

Declaring security meta without the plugin that enforces it fails **at boot**
(`UnguardedRouteMetaError`) instead of silently serving the route open. When
authentication genuinely happens at an outer edge, opt out per adapter with
`fastifyPlugin({ routes, allowUnguardedMeta: true })` (Express and Hono take
the same option; pass `['auth']` to waive a single key).

`src/routes.ts`:

```ts
import { ctx } from '@basaltkit/core'
import { route, HttpError } from '@basaltkit/fastify'
import { z } from 'zod'

const projects = new Map<string, { id: string; name: string }>()

export const routes = [
  // Public — params typed from the Zod schema.
  route({
    method: 'GET',
    url: '/projects/:id',
    params: z.object({ id: z.string() }),
    async handler({ params }) {
      const project = projects.get(params.id)
      if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Not found')
      return project
    },
  }),

  // Requires an authenticated user (auth guard reads `meta.auth`).
  route({
    method: 'POST',
    url: '/projects',
    body: z.object({ name: z.string().min(1) }),
    meta: { auth: true }, // no user → 401 AUTH_REQUIRED
    async handler({ body }) {
      const project = { id: crypto.randomUUID(), name: body.name }
      projects.set(project.id, project)
      ctx().logger.info({ owner: ctx().user?.email }, 'project created')
      return project
    },
  }),

  // Requires a specific permission (permissions guard reads `meta.can`).
  route({
    method: 'DELETE',
    url: '/projects/:id',
    params: z.object({ id: z.string() }),
    meta: { can: 'projects:delete' }, // missing permission → 403
    async handler({ params }) {
      return { deleted: projects.delete(params.id) }
    },
  }),
]
```

`src/server.ts` — wire the plugins and boot. The order in `plugins` doesn't
matter (Basalt boots them in dependency order); enrichers and guards register
themselves into the pipeline every route runs through:

```ts
import { createApp, ctx } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { headerResolver, MemoryTenantSource, tenancyPlugin } from '@basaltkit/tenancy'
import { authPlugin, authRoutes, MemoryUserSource } from '@basaltkit/auth'
import { GLOBAL_SCOPE, MemoryAccessStore, permissionsPlugin } from '@basaltkit/permissions'
import { routes } from './routes.js'

const access = new MemoryAccessStore()
await access.grantToUser('user-ada', ['projects:delete'], GLOBAL_SCOPE)

const app = await createApp({
  plugins: [
    tenancyPlugin({ source: new MemoryTenantSource(), resolvers: [headerResolver()] }),
    authPlugin({ secret: process.env.APP_SECRET!, users: new MemoryUserSource() }),
    permissionsPlugin({ store: access }),
    // authRoutes() adds /auth/register, /auth/login, /auth/me, …
    fastifyPlugin({ routes: [...routes, ...authRoutes()] }),
  ],
}).boot()

const server = app.container.get(FASTIFY)
await server.listen({ port: 3000 })
console.log('http://localhost:3000')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close().then(() => app.shutdown()).then(() => process.exit(0)))
}
```

A request to `POST /projects` without a token gets a `401 AUTH_REQUIRED`; a
`DELETE /projects/:id` from a user lacking `projects:delete` gets a `403` — both
with the standardized error body, and neither check written inside a handler.

## Complete example — Express

Install the adapter and Express:

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/express express
```

`src/app.ts` — wire your plugins and routes (this is identical for every
adapter except the last line):

```ts
import { createApp } from '@basaltkit/core'
import { expressPlugin } from '@basaltkit/express'
import { headerResolver, MemoryTenantSource, tenancyPlugin } from '@basaltkit/tenancy'
import { healthPlugin, metricsPlugin, securityPlugin } from '@basaltkit/http'
import { routes } from './routes.js'

export function buildApp() {
  return createApp({
    plugins: [
      tenancyPlugin({ source: new MemoryTenantSource(), resolvers: [headerResolver()] }),
      securityPlugin({ rateLimit: { limit: 300, windowMs: 60_000 }, headers: true }),
      healthPlugin({ checks: { db: () => ({ ok: true }) } }),
      metricsPlugin(),
      expressPlugin({ routes }), // ← the only adapter-specific line
    ],
  })
}
```

`src/server.ts` — boot, listen, and shut down cleanly:

```ts
import { EXPRESS } from '@basaltkit/express'
import { buildApp } from './app.js'

const app = await buildApp().boot()
const server = app.container.get(EXPRESS).listen(3000, () => console.log('http://localhost:3000'))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(async () => { await app.shutdown(); process.exit(0) }))
}
```

`expressPlugin` adds `express.json()` for you. To integrate into an existing
Express app, pass it in: `expressPlugin({ app: myExistingApp, routes })`.

## Complete example — Hono

Install the adapter, Hono, and (for Node) the Node server:

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/hono hono @hono/node-server
```

`src/app.ts` is the same as above with `honoPlugin({ routes })` in place of
`expressPlugin({ routes })`. Then serve it on Node:

```ts
// src/server.ts
import { serve } from '@hono/node-server'
import { HONO } from '@basaltkit/hono'
import { buildApp } from './app.js'

const app = await buildApp().boot()
serve({ fetch: app.container.get(HONO).fetch, port: 3000 }, (info) =>
  console.log(`http://localhost:${info.port}`),
)
```

### Bun, Deno, Cloudflare Workers, edge

Hono runs on any runtime — export the app's `fetch` and let the platform serve it:

```ts
// Bun / Deno / Cloudflare Workers entry
import { HONO } from '@basaltkit/hono'
import { buildApp } from './app.js'

const app = await buildApp().boot()
export default { fetch: app.container.get(HONO).fetch }
```

::: warning Edge runtimes
The HTTP core, routes, tenancy, auth, permissions and the security/metrics/tracing
edge plugins run on the edge. Node-only infrastructure — `@basaltkit/queue`
(BullMQ), `@basaltkit/prisma`, local file `@basaltkit/storage` — is not available in
Workers/Deno-deploy; use HTTP-based drivers there.
:::

## Uploads

File uploads are adapter-neutral too. Give a route `body: upload({ … })` from
`@basaltkit/http` and it accepts `multipart/form-data` on all three frameworks,
with no `@fastify/multipart`, `multer` or Hono `parseBody` involved. Basalt has
its own streaming parser. It has no dependencies and follows RFC 7578.

```ts
import { route, upload } from '@basaltkit/http'

route({
  method: 'POST',
  url: '/documents',
  body: upload({ maxBytes: 20 * 1024 * 1024, maxFiles: 3, allowedTypes: ['application/pdf', 'image/*'] }),
  meta: { auth: true, rateLimit: { limit: 10, windowMs: 60_000, key: 'user' } },
  async handler({ body }) {
    for await (const file of body.files) {
      // file: { field, filename, declaredType, stream: Readable }
      await files.upload(file.stream, { name: file.filename, contentType: file.declaredType })
    }
    return { fields: body.fields }                // Record<string, string>
  },
})
```

- **The pipeline runs first.** Pre-hooks (rate limit, CORS), enrichers (tenant,
  user) and guards (`auth`, `can`, …) all run before a single body byte is read.
  A rejected upload is answered without being received.
- **Streamed, never buffered.** `body.files` is an async iterable. Each file's
  `stream` is read from the network only as you consume it (backpressure
  included). A file you skip is discarded when you ask for the next one.
  `body.fields` fills as parts arrive: a field sent before a file is available
  when that file is yielded, and all of them once `files` is exhausted.
- **Limits hold on the bytes received**, not on what the client declares. A
  `Content-Length` over `maxBytes` is refused before reading anything.
- **Filenames are sanitised**: directories (`../../x`, `C:\x`), control
  characters and bidi overrides are stripped, so `filename` is a safe label.
  It is still never a storage key. `declaredType` is the client's claim, so
  sniff the bytes (`@basaltkit/files` `validate.sniff`) before trusting it.
- **Nothing hangs.** When the handler returns (or throws) without reading
  everything, the rest is drained in the background up to `maxBytes` and the
  response carries `Connection: close`.

| `upload()` option | Default | Past it |
|---|---|---|
| `maxBytes` (required) | none | `413 PAYLOAD_TOO_LARGE`, for the whole request including multipart framing |
| `maxFiles` (required) | none | `400 TOO_MANY_FILES` |
| `maxFileBytes` | `maxBytes` | `413 PAYLOAD_TOO_LARGE` |
| `maxFields` | `50` | `400 TOO_MANY_FIELDS` |
| `maxFieldBytes` | 64 KiB | `413 PAYLOAD_TOO_LARGE` |
| `maxHeaderBytes` | 8 KiB (per part) | `400 MALFORMED_MULTIPART` |
| `allowedTypes` | any | `415 UNSUPPORTED_MEDIA_TYPE` for a file part whose declared type is not listed (`image/png`, or `image/*`) |

Other errors: `415 UNSUPPORTED_MEDIA_TYPE` if the request is not
`multipart/form-data`. `400 MALFORMED_MULTIPART` for a missing, repeated or
invalid boundary, a body that ends before the closing boundary (truncated or
aborted upload), malformed or folded part headers, a nested `multipart/*` part,
or a `Content-Transfer-Encoding` other than binary.

Each adapter only hands over the raw request stream. Fastify gets a pass-through
`multipart/form-data` parser, registered only when an upload route exists and
never over one you registered yourself. Other Fastify routes still answer 415.
Express's `json()`/`urlencoded()` parsers never read multipart. Hono skips its
`bodyLimit` buffering for multipart; a non-upload route still parses a
multipart body within `bodyLimit`. In OpenAPI the route's request body is
documented as `multipart/form-data`.

## How it works

- **`@basaltkit/http`** defines the neutral `HttpRequest` / `HttpReply` and the
  `runRoute` pipeline. Enrichers and guards (tenancy, auth, permissions)
  register into the `http:enrichers` / `http:guards` metadata buckets — they are
  framework-agnostic and every adapter runs them.
- Each **adapter** maps its framework's request/response to the neutral shape,
  invokes `runRoute`, and maps thrown errors with the shared `toErrorResponse`
  — so a validation failure is `400 HTTP_VALIDATION` and an `HttpError(404)` is a
  404 with the same body on all three. Unmatched routes get the same treatment:
  every adapter serves the neutral `404 { "error": { "code": "NOT_FOUND", … } }`
  instead of its framework's default (opt out with `notFound: false` on the
  adapter plugin). A structured payload
  (`new HttpError(422, code, message, { details })`) is sanitised and serialised
  as `error.details` by that same neutral serializer, so it is identical on the
  three — see [Structured error details](/guide/concepts#structured-error-details).
- The handler's `request` / `reply` are the neutral types; reach the underlying
  framework object via `request.raw` when you truly need it.

## Options reference

All three plugins share the same core options; each accepts its framework's
native extras.

| Option | Type | Default | Adapters | Why |
|---|---|---|---|---|
| `routes` | `BasaltRoute[]` | `[]` | all | The neutral routes to mount. |
| `allowUnguardedMeta` | `boolean \| string[]` | fail loud at boot | all | Waives the boot check that every route declaring a guarded security key (`meta.auth`/`can`/`teamRole`/`scopes`/`subscribed`/`feature`) has a registered guard enforcing it (`UnguardedRouteMetaError` otherwise). Only for deployments where protection genuinely happens at an outer edge. |
| `notFound` | `boolean` | `true` (neutral 404 body) | all | Pass `false` to opt out of the shared `404 { error: { code: 'NOT_FOUND' } }` and keep the framework default. |
| `fastify` | `FastifyServerOptions` | `{}` | fastify | Passed to the `Fastify()` constructor (logger, trustProxy, …). |
| `app` | native instance | created for you | express, hono | Bring your own `express()` / `new Hono()` and Basalt mounts onto it. |
| `bodyLimit` | `number` (bytes) | 1 MiB | hono | Rejects oversized bodies with 413 (`PAYLOAD_TOO_LARGE`) — Hono/edge has no default cap. Enforced on the bytes actually read: a chunked/streamed body without `Content-Length` is counted while buffering and cut off at the limit. An `upload()` route is bounded by its own `maxBytes` instead (streamed, never buffered). |
| `getClientIp` | `(c: Context) => string \| undefined` | socket address (`@hono/node-server`, Bun) | hono | Sets `request.ip`, the key for per-client rate limiting and the IP login throttle. On an edge runtime or behind a trusted proxy, supply it (e.g. `(c) => c.req.header('cf-connecting-ip')` on Cloudflare). When no IP resolves, a one-time warning is printed and rate limits share one bucket. Never read `X-Forwarded-For` unless a proxy you control overwrites it. |
| `errorHandler` | `boolean` | `true` | express | Final `(err, req, res, next)` middleware that turns body-parser and pre-hook errors into the neutral JSON envelope (`400 BAD_REQUEST`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, otherwise `500 INTERNAL_ERROR`) instead of Express's HTML page with a stack trace. Pass `false` only if you mount your own error handler after boot. |

## Failure modes

| You see | It means | Do |
|---|---|---|
| `UnguardedRouteMetaError` at boot | a route declares security meta no registered guard enforces | register the enforcing plugin, or `allowUnguardedMeta` (see [Security](/guide/security)) |
| `500 HTTP_GUARDS_UNRUNNABLE` | the route pipeline carries guards but no container, so none of them could run | pass `container` to the pipeline — every shipped adapter does; only hand-built pipelines can hit this |
| `400 HTTP_VALIDATION` | body/query/params failed the route's Zod schema | the response lists the part and per-field issues |
| `404 { code: 'NOT_FOUND' }` on a route you defined | the route wasn't registered on this adapter instance | check it is in `routes: [...]` of the adapter plugin that booted |
| `413 PAYLOAD_TOO_LARGE` | body exceeded `bodyLimit` (hono) or the body-parser limit (express, 100 KB by default) | raise the limit deliberately |
| `400 BAD_REQUEST` (express) | the body could not be parsed (malformed JSON, corrupt encoding) | send a valid body |
| `400 MALFORMED_MULTIPART` / `TOO_MANY_FILES`, `413`, `415` on an `upload()` route | the upload broke a limit or the multipart framing | see [Uploads](#uploads) |
| `[basalt:hono] Could not resolve the client IP` warning | this runtime exposes no socket address to the adapter | pass `honoPlugin({ getClientIp })` |

## Edge plugins are neutral too

The edge plugins target a neutral `HttpServer` (the `HTTP_SERVER` token, which
every adapter provides), so they run on **all three** frameworks unchanged:
`securityPlugin`, `metricsPlugin`, `healthPlugin`, `tracingPlugin` and
`openapiPlugin`. Add them to `plugins: [...]` next to any adapter.

```ts
createApp({
  plugins: [
    expressPlugin({ routes }),          // or fastifyPlugin / honoPlugin
    securityPlugin({ rateLimit, cors, headers: true }),
    healthPlugin({ checks }),
    metricsPlugin(),
    tracingPlugin({ exporter }),
    openapiPlugin({ info }),
  ],
})
```

The one exception is **`idempotencyPlugin`**, which intercepts the response
body — that remains Fastify-specific for now.
