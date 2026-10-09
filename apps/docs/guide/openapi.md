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
becomes a `bearerAuth` security requirement automatically, and `meta.scopes` an
API-key one — see [Security schemes](#security-schemes-sessions-and-api-keys).

## Security schemes: sessions and API keys

Each operation's `security` is derived from its route meta:

| Route meta | `security` | Notes |
|---|---|---|
| `scopes: ['orders:read']` | `[{ apiKeyAuth: [] }]` | plus `x-required-scopes: ['orders:read']`; even with `auth: true` too, because only an API key holding the scopes passes |
| `auth: true` | `[{ bearerAuth: [] }]` | plus `{ apiKeyAuth: [] }` as an alternative only with `apiKey.onAuthRoutes` and not `meta.apiKey: false` |
| neither | none (public) | |

`components.securitySchemes` lists only the schemes some operation uses:
`bearerAuth` (HTTP bearer, JWT) and `apiKeyAuth`, an `apiKey` scheme in the
header `apiKeysPlugin` reads. Its description says the key is also accepted as
`Authorization: Bearer <key>`, that a key without `*` reaches only the
operations listing `x-required-scopes`, and lists every scope the document uses.

**Why `x-required-scopes`.** The document is OpenAPI 3.0.3, which allows scopes
in a security requirement only for OAuth2 and OpenID Connect schemes; for an
`apiKey` scheme the array must be empty. The scopes an operation needs are
therefore published in the `x-required-scopes` extension next to it.

**The `apiKey` option.** By default the scheme uses the `x-api-key` header and
appears only on `meta.scopes` routes. Pass the header when `apiKeysPlugin` uses
a custom one, and `false` to leave API keys out of the document
(`x-required-scopes` is still emitted):

```ts
apiKeysPlugin({ header: 'x-machine-key' })
openapiPlugin({ info, apiKey: { header: 'x-machine-key' } })
```

`onAuthRoutes: true` also offers the key as an alternative to the session on
`meta.auth` routes. Turn it on only when it is true for your keys: they carry a
`userId`, `apiKeysPlugin` was given `users` (so a key resolves `ctx().user`, which
`meta.auth` requires), and they hold `*` or `apiKeysPlugin` sets
`allowNarrowKeysOnUnscopedRoutes`. Otherwise those routes answer 401/403 to a key
and the document would claim they accept one.

**Idempotency-Key.** With `idempotencyPlugin` registered, the operations whose
method it guards get its header (as configured, default `Idempotency-Key`) as an
optional header parameter, with the replay, 409 and 422 behaviour described.
Pass `idempotency: false` to leave it out. `generate:docs` writes the same
document the plugin serves.

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

::: warning `securityPlugin` blocks the docs UI by default
`securityPlugin` (on by default in the scaffold) sets a lock-down CSP
(`default-src 'none'`) that blocks the CDN and inline scripts this page needs, so
the UI renders blank. Override the CSP **for the `/docs` route only** — the
handler runs after the security pre-hook, so its header wins and the rest of the
API stays locked down:

```ts
void reply.header(
  'content-security-policy',
  "default-src 'self'; script-src 'self' https://unpkg.com 'unsafe-inline'; " +
    "style-src 'self' https://unpkg.com 'unsafe-inline'; img-src 'self' data:; " +
    "font-src 'self' data:; connect-src 'self'",
)
```
:::

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
