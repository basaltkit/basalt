# OpenAPI

Your routes already declare their shape with Zod. `openapiPlugin` turns that
into a live OpenAPI 3.0 document — no second source of truth, no annotations.

[[toc]]

```ts
// src/app.ts
import { z } from 'zod'
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY, route, openapiPlugin } from '@basaltkit/fastify'

export const createUser = route({
  method: 'POST',
  url: '/users',
  body: z.object({ email: z.string().email(), name: z.string() }),
  response: { 201: z.object({ id: z.string() }) },
  meta: { auth: true },                       // → bearerAuth security requirement
  handler: ({ body }) => ({ id: '1', ...body }),
})

const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [createUser] }),  // registers the routes for OpenAPI
    openapiPlugin({ info: { title: 'Acme API', version: '1.0.0', description: 'The Acme public API' } }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
// serves GET /openapi.json  (pass `path` to change it)
```

The document is generated from the app's registered routes and their
`body` / `query` / `params` / `response` schemas — so `openapiPlugin` needs
`fastifyPlugin` (which publishes the routes) present. Route `meta: { auth: true }`
becomes a `bearerAuth` security requirement automatically.

## Rendering a UI

`/openapi.json` is a standard document — point any viewer at it. A tiny
self-contained Swagger UI route:

```ts
route({
  method: 'GET',
  url: '/docs',
  async handler({ reply }) {
    void reply.header('content-type', 'text/html')
    return `<!doctype html><html><head>
      <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css">
    </head><body><div id="ui"></div>
      <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
      <script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui' })</script>
    </body></html>`
  },
})
```

## Generating without serving

`generateOpenApi(routes, info)` is a pure function — use it to write the spec to
a file in CI, or feed it to a client-SDK generator.

```ts
import { generateOpenApi } from '@basaltkit/fastify'
import { writeFileSync } from 'node:fs'
import { createUser } from './app.js'

const doc = generateOpenApi([createUser], {
  title: 'Acme API',
  version: '1.0.0',
  description: 'The Acme public API',
})
writeFileSync('openapi.json', JSON.stringify(doc, null, 2))
```

The bundled `zodToJsonSchema()` covers the common Zod subset (objects, strings
with formats, numbers, enums, arrays, unions, optionals/defaults). Unknown types
degrade to `{}` rather than throwing, so documentation never breaks a boot.
