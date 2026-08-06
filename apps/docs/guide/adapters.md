# HTTP Adapters

Machize is **not tied to one HTTP framework**. The route pipeline —
validation, enrichers, guards, context and error mapping — lives in a neutral
core (`@machize/http`), and each framework is a thin adapter over it. Write your
routes, tenancy, auth and permissions **once**, and run them on Fastify,
Express or Hono unchanged.

| Adapter | Package | Serve with |
| --- | --- | --- |
| Fastify | `@machize/fastify` | `app.container.get(FASTIFY).listen({ port })` |
| Express | `@machize/express` | `app.container.get(EXPRESS).listen(port)` |
| Hono | `@machize/hono` | `@hono/node-server`, Bun, Deno, or an edge `fetch` export |

## The same routes everywhere

```ts
import { route, HttpError } from '@machize/http' // or from '@machize/fastify'
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
import { fastifyPlugin, FASTIFY } from '@machize/fastify'

const app = await createApp({ plugins: [/* … */, fastifyPlugin({ routes })] }).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
```

```ts [Express]
import { expressPlugin, EXPRESS } from '@machize/express'

const app = await createApp({ plugins: [/* … */, expressPlugin({ routes })] }).boot()
app.container.get(EXPRESS).listen(3000)
```

```ts [Hono]
import { honoPlugin, HONO } from '@machize/hono'
import { serve } from '@hono/node-server'

const app = await createApp({ plugins: [/* … */, honoPlugin({ routes })] }).boot()
serve({ fetch: app.container.get(HONO).fetch, port: 3000 })
```

:::

## Complete example — Express

Install the adapter and Express:

```bash
pnpm add @machize/core @machize/http @machize/express express
```

`src/app.ts` — wire your plugins and routes (this is identical for every
adapter except the last line):

```ts
import { createApp } from '@machize/core'
import { expressPlugin } from '@machize/express'
import { headerResolver, MemoryTenantSource, tenancyPlugin } from '@machize/tenancy'
import { healthPlugin, metricsPlugin, securityPlugin } from '@machize/http'
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
import { EXPRESS } from '@machize/express'
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
pnpm add @machize/core @machize/http @machize/hono hono @hono/node-server
```

`src/app.ts` is the same as above with `honoPlugin({ routes })` in place of
`expressPlugin({ routes })`. Then serve it on Node:

```ts
// src/server.ts
import { serve } from '@hono/node-server'
import { HONO } from '@machize/hono'
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
import { HONO } from '@machize/hono'
import { buildApp } from './app.js'

const app = await buildApp().boot()
export default { fetch: app.container.get(HONO).fetch }
```

::: warning Edge runtimes
The HTTP core, routes, tenancy, auth, permissions and the security/metrics/tracing
edge plugins run on the edge. Node-only infrastructure — `@machize/queue`
(BullMQ), `@machize/prisma`, local file `@machize/storage` — is not available in
Workers/Deno-deploy; use HTTP-based drivers there.
:::

## How it works

- **`@machize/http`** defines the neutral `HttpRequest` / `HttpReply` and the
  `runRoute` pipeline. Enrichers and guards (tenancy, auth, permissions)
  register into the `http:enrichers` / `http:guards` metadata buckets — they are
  framework-agnostic and every adapter runs them.
- Each **adapter** maps its framework's request/response to the neutral shape,
  invokes `runRoute`, and maps thrown errors with the shared `toErrorResponse`
  — so a validation failure is `400 HTTP_VALIDATION` and an `HttpError(404)` is a
  404 with the same body on all three.
- The handler's `request` / `reply` are the neutral types; reach the underlying
  framework object via `request.raw` when you truly need it.

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
