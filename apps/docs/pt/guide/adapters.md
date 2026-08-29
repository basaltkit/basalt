# Adaptadores HTTP

O Basalt **não está preso a uma única framework HTTP**. O pipeline de rotas —
validação, enrichers, guards, contexto e mapeamento de erros — vive num core
neutro (`@basaltkit/http`), e cada framework é um adaptador fino por cima. Escreve
as tuas rotas, tenancy, auth e permissões **uma vez**, e corre-as em Fastify,
Express ou Hono sem alterações.

| Adaptador | Pacote | Serve com |
| --- | --- | --- |
| Fastify | `@basaltkit/fastify` | `app.container.get(FASTIFY).listen({ port })` |
| Express | `@basaltkit/express` | `app.container.get(EXPRESS).listen(port)` |
| Hono | `@basaltkit/hono` | `@hono/node-server`, Bun, Deno, ou um export `fetch` de edge |

## As mesmas rotas em todo o lado

```ts
import { route, HttpError } from '@basaltkit/http' // ou de '@basaltkit/fastify'
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

Escolhe um adaptador — tudo o resto (resolvers de tenancy, guards de auth,
permissões, validação Zod, o formato de erro padronizado) comporta-se de forma
idêntica:

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

## Exemplo vivo — o playground

O [`apps/playground`](https://github.com/basaltkit/basalt/tree/main/apps/playground)
do repositório é a mesma lista neutra de `route()` (um pequeno CRUD de Projetos +
multi-tenancy) servida nos **três** adaptadores. Só muda a última linha do
`buildApp()` — escolhe o runtime com uma variável de ambiente:

```bash
pnpm --filter playground dev               # fastify (por omissão)
ADAPTER=express pnpm --filter playground dev
ADAPTER=hono    pnpm --filter playground dev
```

O seu `tests/adapters.e2e.test.ts` corre o fluxo idêntico sobre um socket real em
Fastify, Express e Hono — a prova executável de que as rotas são neutras ao runtime.

## Exemplo completo — Fastify

Instala o adaptador e o Fastify:

```bash
pnpm add @basaltkit/core @basaltkit/fastify fastify @basaltkit/tenancy @basaltkit/auth @basaltkit/permissions zod
```

As rotas são tipadas a partir dos seus schemas Zod e protegidas
declarativamente através de `meta`. Os **enrichers** correm primeiro (a tenancy
resolve o tenant, a auth lê o token `Authorization: Bearer` para `ctx().user`);
depois correm os **guards** (`meta: { auth: true }` exige um utilizador,
`meta: { can: '…' }` exige uma permissão). Um guard rejeita lançando uma exceção
— nunca escreves essa verificação à mão.

Declarar meta de segurança sem o plugin que a aplica falha **no boot**
(`UnguardedRouteMetaError`) em vez de servir a rota aberta silenciosamente.
Quando a autenticação acontece genuinamente numa edge exterior, opta por sair
por adapter com `fastifyPlugin({ routes, allowUnguardedMeta: true })` (Express e
Hono aceitam a mesma opção; passa `['auth']` para dispensar uma única chave).

`src/routes.ts`:

```ts
import { ctx } from '@basaltkit/core'
import { route, HttpError } from '@basaltkit/fastify'
import { z } from 'zod'

const projects = new Map<string, { id: string; name: string }>()

export const routes = [
  // Pública — params tipados a partir do schema Zod.
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

  // Requer um utilizador autenticado (o guard de auth lê `meta.auth`).
  route({
    method: 'POST',
    url: '/projects',
    body: z.object({ name: z.string().min(1) }),
    meta: { auth: true }, // sem utilizador → 401 AUTH_REQUIRED
    async handler({ body }) {
      const project = { id: crypto.randomUUID(), name: body.name }
      projects.set(project.id, project)
      ctx().logger.info({ owner: ctx().user?.email }, 'project created')
      return project
    },
  }),

  // Requer uma permissão específica (o guard de permissões lê `meta.can`).
  route({
    method: 'DELETE',
    url: '/projects/:id',
    params: z.object({ id: z.string() }),
    meta: { can: 'projects:delete' }, // permissão em falta → 403
    async handler({ params }) {
      return { deleted: projects.delete(params.id) }
    },
  }),
]
```

`src/server.ts` — liga os plugins e arranca. A ordem em `plugins` não importa (o
Basalt arranca-os por ordem de dependência); os enrichers e guards registam-se a
si próprios no pipeline por onde cada rota corre:

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
    // authRoutes() adiciona /auth/register, /auth/login, /auth/me, …
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

Um pedido a `POST /projects` sem token recebe um `401 AUTH_REQUIRED`; um
`DELETE /projects/:id` de um utilizador sem `projects:delete` recebe um `403` —
ambos com o corpo de erro padronizado, e nenhuma das verificações escrita dentro
de um handler.

## Exemplo completo — Express

Instala o adaptador e o Express:

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/express express
```

`src/app.ts` — liga os teus plugins e rotas (isto é idêntico para cada adaptador
exceto na última linha):

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
      expressPlugin({ routes }), // ← a única linha específica do adaptador
    ],
  })
}
```

`src/server.ts` — arranca, escuta e encerra de forma limpa:

```ts
import { EXPRESS } from '@basaltkit/express'
import { buildApp } from './app.js'

const app = await buildApp().boot()
const server = app.container.get(EXPRESS).listen(3000, () => console.log('http://localhost:3000'))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(async () => { await app.shutdown(); process.exit(0) }))
}
```

O `expressPlugin` adiciona `express.json()` por ti. Para integrar numa app
Express existente, passa-a: `expressPlugin({ app: myExistingApp, routes })`.

## Exemplo completo — Hono

Instala o adaptador, o Hono e (para Node) o servidor Node:

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/hono hono @hono/node-server
```

`src/app.ts` é o mesmo que acima com `honoPlugin({ routes })` no lugar de
`expressPlugin({ routes })`. Depois serve-o em Node:

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

O Hono corre em qualquer runtime — exporta o `fetch` da app e deixa a plataforma
servi-lo:

```ts
// Entry point Bun / Deno / Cloudflare Workers
import { HONO } from '@basaltkit/hono'
import { buildApp } from './app.js'

const app = await buildApp().boot()
export default { fetch: app.container.get(HONO).fetch }
```

::: warning Aviso: Runtimes de edge
O core HTTP, as rotas, tenancy, auth, permissões e os plugins de edge de
security/metrics/tracing correm no edge. Infraestrutura só-de-Node —
`@basaltkit/queue` (BullMQ), `@basaltkit/prisma`, ficheiros locais
`@basaltkit/storage` — não está disponível em Workers/Deno-deploy; usa aí drivers
baseados em HTTP.
:::

## Como funciona

- **`@basaltkit/http`** define os neutros `HttpRequest` / `HttpReply` e o pipeline
  `runRoute`. Os enrichers e guards (tenancy, auth, permissões) registam-se nos
  buckets de metadata `http:enrichers` / `http:guards` — são agnósticos à
  framework e cada adaptador corre-os.
- Cada **adaptador** mapeia o request/response da sua framework para o formato
  neutro, invoca `runRoute`, e mapeia os erros lançados com o partilhado
  `toErrorResponse` — por isso uma falha de validação é `400 HTTP_VALIDATION` e
  um `HttpError(404)` é um 404 com o mesmo corpo nos três. Rotas não
  correspondidas recebem o mesmo tratamento: todos os adapters servem o neutro
  `404 { "error": { "code": "NOT_FOUND", … } }` em vez do default da sua
  framework (desativa com `notFound: false` no plugin do adapter).
- O `request` / `reply` do handler são os tipos neutros; alcança o objeto
  subjacente da framework via `request.raw` quando realmente precisares.

## Referência de opções

Os três plugins partilham as mesmas opções centrais; cada um aceita os extras
nativos da sua framework.

| Opção | Tipo | Default | Adapters | Porquê |
|---|---|---|---|---|
| `routes` | `BasaltRoute[]` | `[]` | todos | As rotas neutras a montar. |
| `allowUnguardedMeta` | `boolean \| string[]` | falha alto no boot | todos | Dispensa o check de boot de que cada rota que declara `meta.auth`/`can`/`teamRole` tem um guard registado a aplicá-la (`UnguardedRouteMetaError` caso contrário). Só para deployments onde a proteção acontece genuinamente numa edge exterior. |
| `notFound` | `boolean` | `true` (corpo 404 neutro) | todos | Passa `false` para sair do `404 { error: { code: 'NOT_FOUND' } }` partilhado e manter o default da framework. |
| `fastify` | `FastifyServerOptions` | `{}` | fastify | Passado ao construtor `Fastify()` (logger, trustProxy, …). |
| `app` | instância nativa | criada por ti ou pelo plugin | express, hono | Traz o teu próprio `express()` / `new Hono()` e o Basalt monta-se nele. |
| `bodyLimit` | `number` (bytes) | 1 MiB | hono | Rejeita bodies grandes demais com 413 (`PAYLOAD_TOO_LARGE`) — o Hono/edge não tem limite por omissão. |

## Modos de falha

| Vês | Significa | Faz |
|---|---|---|
| `UnguardedRouteMetaError` no boot | uma rota declara meta de segurança que nenhum guard registado aplica | regista o plugin que a aplica, ou `allowUnguardedMeta` (vê [Segurança](/pt/guide/security)) |
| `400 HTTP_VALIDATION` | o body/query/params falhou o schema Zod da rota | a resposta lista a parte e as issues por campo |
| `404 { code: 'NOT_FOUND' }` numa rota que definiste | a rota não foi registada nesta instância do adapter | confirma que está em `routes: [...]` do plugin do adapter que arrancou |
| `413 PAYLOAD_TOO_LARGE` (hono) | o body excedeu o `bodyLimit` | sobe o `bodyLimit` deliberadamente |

## Os plugins de edge também são neutros

Os plugins de edge visam um `HttpServer` neutro (o token `HTTP_SERVER`, que cada
adaptador fornece), por isso correm nas **três** frameworks sem alterações:
`securityPlugin`, `metricsPlugin`, `healthPlugin`, `tracingPlugin` e
`openapiPlugin`. Adiciona-os a `plugins: [...]` ao lado de qualquer adaptador.

```ts
createApp({
  plugins: [
    expressPlugin({ routes }),          // ou fastifyPlugin / honoPlugin
    securityPlugin({ rateLimit, cors, headers: true }),
    healthPlugin({ checks }),
    metricsPlugin(),
    tracingPlugin({ exporter }),
    openapiPlugin({ info }),
  ],
})
```

A única exceção é o **`idempotencyPlugin`**, que interceta o corpo da resposta —
esse permanece específico do Fastify por agora.
