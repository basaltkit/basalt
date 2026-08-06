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
