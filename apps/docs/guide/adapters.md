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
import { MemoryAccessStore, permissionsPlugin } from '@basaltkit/permissions'
import { routes } from './routes.js'

const access = new MemoryAccessStore()
await access.grantToUser('user-ada', ['projects:delete'], 'global')

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
  adapter plugin).
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
| `bodyLimit` | `number` (bytes) | 1 MiB | hono | Rejects oversized bodies with 413 (`PAYLOAD_TOO_LARGE`) — Hono/edge has no default cap. |

## Failure modes

| You see | It means | Do |
|---|---|---|
| `UnguardedRouteMetaError` at boot | a route declares security meta no registered guard enforces | register the enforcing plugin, or `allowUnguardedMeta` (see [Security](/guide/security)) |
| `400 HTTP_VALIDATION` | body/query/params failed the route's Zod schema | the response lists the part and per-field issues |
| `404 { code: 'NOT_FOUND' }` on a route you defined | the route wasn't registered on this adapter instance | check it is in `routes: [...]` of the adapter plugin that booted |
| `413 PAYLOAD_TOO_LARGE` (hono) | body exceeded `bodyLimit` | raise `bodyLimit` deliberately |

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
