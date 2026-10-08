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
rota torna-se automaticamente num requisito de segurança `bearerAuth`, e o
`meta.scopes` num de API key — vê [Esquemas de segurança](#security-schemes-sessions-and-api-keys).

## Esquemas de segurança: sessões e API keys {#security-schemes-sessions-and-api-keys}

O `security` de cada operação é derivado do meta da rota:

| Meta da rota | `security` | Notas |
|---|---|---|
| `scopes: ['orders:read']` | `[{ apiKeyAuth: [] }]` | mais `x-required-scopes: ['orders:read']`; mesmo com `auth: true`, porque só uma API key com os scopes passa |
| `auth: true` | `[{ bearerAuth: [] }]` | mais `{ apiKeyAuth: [] }` como alternativa só com `apiKey.onAuthRoutes` e sem `meta.apiKey: false` |
| nenhum | nenhum (público) | |

`components.securitySchemes` lista só os esquemas que alguma operação usa:
`bearerAuth` (HTTP bearer, JWT) e `apiKeyAuth`, um esquema `apiKey` no header que
o `apiKeysPlugin` lê. A sua descrição diz que a chave também é aceite como
`Authorization: Bearer <key>`, que uma chave sem `*` só alcança as operações que
listam `x-required-scopes`, e lista todos os scopes que o documento usa.

**Porquê `x-required-scopes`.** O documento é OpenAPI 3.0.3, que só permite
scopes num requisito de segurança para esquemas OAuth2 e OpenID Connect; para um
esquema `apiKey` o array tem de ser vazio. Os scopes de que uma operação precisa
são por isso publicados na extensão `x-required-scopes` ao lado dela.

**A opção `apiKey`.** Por omissão o esquema usa o header `x-api-key` e só aparece
em rotas com `meta.scopes`. Passa o header quando o `apiKeysPlugin` usa um
personalizado, e `false` para deixar as API keys fora do documento (o
`x-required-scopes` continua a ser emitido):

```ts
apiKeysPlugin({ header: 'x-machine-key' })
openapiPlugin({ info, apiKey: { header: 'x-machine-key' } })
```

`onAuthRoutes: true` oferece também a chave como alternativa à sessão nas rotas
com `meta.auth`. Liga-o só quando isso é verdade para as tuas chaves: têm um
`userId`, o `apiKeysPlugin` recebeu `users` (para que uma chave resolva
`ctx().user`, que o `meta.auth` exige), e têm `*` ou o `apiKeysPlugin` define
`allowNarrowKeysOnUnscopedRoutes`. Caso contrário essas rotas respondem 401/403 a
uma chave e o documento afirmaria que a aceitam.

**Idempotency-Key.** Com o `idempotencyPlugin` registado, as operações cujo
método ele protege recebem o seu header (como configurado, por omissão
`Idempotency-Key`) como parâmetro de header opcional, com o comportamento de
replay, 409 e 422 descrito. Passa `idempotency: false` para o deixar de fora. O
`generate:docs` escreve o mesmo documento que o plugin serve.

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
