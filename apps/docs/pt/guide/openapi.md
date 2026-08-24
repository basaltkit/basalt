# OpenAPI

As tuas rotas já declaram a sua forma com Zod. `openapiPlugin` transforma isso
num documento OpenAPI 3.0 vivo — sem uma segunda fonte de verdade, sem anotações.

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
  meta: { auth: true },                       // → requisito de segurança bearerAuth
  handler: ({ body }) => ({ id: '1', ...body }),
})

const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [createUser] }),  // regista as rotas para OpenAPI
    openapiPlugin({ info: { title: 'Acme API', version: '1.0.0', description: 'The Acme public API' } }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
// serve GET /openapi.json  (passa `path` para mudar)
```

O documento é gerado a partir das rotas registadas da app e dos seus schemas
`body` / `query` / `params` / `response` — por isso `openapiPlugin` precisa de
`fastifyPlugin` (que publica as rotas) presente. O `meta: { auth: true }` de uma
rota torna-se automaticamente num requisito de segurança `bearerAuth`.

## Renderizar uma UI

`/openapi.json` é um documento standard — aponta qualquer viewer para ele. Uma
rota Swagger UI minúscula e autocontida:

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

::: warning O `securityPlugin` bloqueia a UI de docs por omissão
O `securityPlugin` (ligado por omissão no scaffold) mete um CSP de lock-down
(`default-src 'none'`) que bloqueia o CDN e os scripts inline que esta página
precisa, por isso a UI aparece em branco. Sobrepõe o CSP **só para a rota
`/docs`** — o handler corre depois do pre-hook de segurança, por isso o header
dele vence e o resto da API continua bloqueado:

```ts
void reply.header(
  'content-security-policy',
  "default-src 'self'; script-src 'self' https://unpkg.com 'unsafe-inline'; " +
    "style-src 'self' https://unpkg.com 'unsafe-inline'; img-src 'self' data:; " +
    "font-src 'self' data:; connect-src 'self'",
)
```
:::

## Gerar sem servir

`generateOpenApi(routes, info)` é uma função pura — usa-a para escrever a spec
para um ficheiro em CI, ou alimenta-a a um gerador de SDK de cliente.

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

O `zodToJsonSchema()` incluído cobre o subconjunto comum do Zod (objetos, strings
com formatos, números, enums, arrays, unions, optionals/defaults). Tipos
desconhecidos degradam para `{}` em vez de lançar, por isso a documentação nunca
quebra um boot.
