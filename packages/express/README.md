# @machize/express

Adaptador do Machize para [Express](https://expressjs.com): as mesmas rotas tipadas, enrichers e guards que usarias no Fastify ou no Hono, a correr num servidor Express. Precisas dele quando já usas Express (ou queres o seu enorme ecossistema de middleware) e queres a validação, o contexto por pedido e os erros padronizados do Machize.

## O que este módulo resolve

O [Express](https://expressjs.com) é o servidor HTTP mais conhecido do Node.js — o programa que recebe **pedidos HTTP** (mensagens como "cria este projeto") e devolve respostas. Mas o Express, por si só, não valida dados, não tipa nada em TypeScript e cada projeto inventa o seu próprio formato de erros.

Este módulo liga o Express ao Machize. As **rotas** (endereço + método, ex.: `POST /echo`) definem-se com a função `route()` do `@machize/http`, num formato neutro com esquemas [Zod](https://zod.dev) para validação. O adaptador converte cada pedido do Express para esse formato neutro, corre o pipeline partilhado (validação, *enrichers* — funções que enriquecem o contexto do pedido, como resolver o tenant — e *guards* — funções que podem recusar o pedido, como autenticação) e converte erros em respostas JSON com formato estável.

O ponto forte: **portabilidade**. Uma rota escrita para este adaptador corre sem alterar uma linha no `@machize/fastify` e no `@machize/hono`. E os plugins de borda neutros (segurança, saúde, métricas, tracing, OpenAPI) do `@machize/http` funcionam aqui tal e qual.

## Instalação

```bash
pnpm add @machize/express @machize/core @machize/http express zod
```

O `express` (versão 4.19+ ou 5) é *peer dependency* — instala-lo tu. O `zod` é necessário para os esquemas das rotas.

## Começar em 5 minutos

**Passo 1** — instala os pacotes (comando acima).

**Passo 2** — cria um ficheiro `server.ts`:

```ts
import { createApp } from '@machize/core'
import { route } from '@machize/http'
import { EXPRESS, expressPlugin } from '@machize/express'
import { z } from 'zod'

// 1. Definir uma rota: método, URL, validação e handler (a função que responde).
const echo = route({
  method: 'POST',
  url: '/echo',
  body: z.object({ n: z.number() }), // o corpo tem de ter um número n
  async handler({ body, reply }) {
    // body.n já está validado e tipado como number
    return reply.code(201).send({ doubled: body.n * 2 })
  },
})

// 2. Criar a app Machize com o plugin Express e arrancar.
const app = await createApp({ plugins: [expressPlugin({ routes: [echo] })] }).boot()

// 3. Obter a app Express do contentor e pôr a ouvir numa porta.
app.container.get(EXPRESS).listen(3000)
console.log('A ouvir em http://localhost:3000')
```

**Passo 3** — executa e testa:

```bash
npx tsx server.ts
curl -X POST http://localhost:3000/echo \
  -H 'content-type: application/json' \
  -d '{"n":21}'
# → {"doubled":42}   (estado 201)

curl -X POST http://localhost:3000/echo \
  -H 'content-type: application/json' \
  -d '{"n":"nope"}'
# → 400 {"error":{"code":"HTTP_VALIDATION","part":"body","issues":[...]}}
```

> O plugin já ativa `express.json()` por ti — não precisas de configurar o parsing de JSON.

## Guia de utilização

### Rotas com parâmetros, query e erros

```ts
import { HttpError, route } from '@machize/http'
import { z } from 'zod'

const hello = route({
  method: 'GET',
  url: '/hello/:name', // :name é um parâmetro dinâmico do URL
  params: z.object({ name: z.string() }),
  async handler({ params }) {
    return { hello: params.name }
  },
})

const boom = route({
  method: 'GET',
  url: '/boom',
  async handler() {
    // Erro intencional: vira uma resposta 418 com um código estável
    throw new HttpError(418, 'TEAPOT', "I'm a teapot")
  },
})
```

O formato de erro é idêntico ao dos outros adaptadores: `{ error: { code, message, ... } }`. Erros inesperados respondem `500` com `INTERNAL_ERROR`, sem expor detalhes internos.

### Enrichers e guards (autenticação, tenancy, …)

Plugins registam estas funções nos "buckets" de metadados do contentor; o adaptador aplica-as a todas as rotas. Exemplo real (dos testes do pacote) — um enricher tipo tenancy e um guard tipo auth:

```ts
import { createApp, definePlugin, ensureMetadata, tryCtx } from '@machize/core'
import { HttpError, route, type RequestEnricher, type RouteGuard } from '@machize/http'
import { EXPRESS, expressPlugin } from '@machize/express'
import { z } from 'zod'

// Enricher: corre antes de tudo e anexa o tenant ao contexto do pedido.
const enricher: RequestEnricher = ({ request, context }) => {
  const tenant = request.headers['x-tenant-id']
  if (typeof tenant === 'string') (context as { tenant?: unknown }).tenant = { id: tenant }
}

// Guard: recusa o pedido lançando um erro. Lê o meta da rota.
const guard: RouteGuard = ({ route: def, request }) => {
  if (def.meta?.['auth'] && !request.headers['authorization']) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Autenticação obrigatória.')
  }
}

const meuPlugin = definePlugin({
  name: 'meu:http',
  register({ container }) {
    const metadata = ensureMetadata(container)
    metadata.add('http:enrichers', enricher)
    metadata.add('http:guards', guard)
  },
})

const secure = route({
  method: 'GET',
  url: '/secure',
  meta: { auth: true }, // o guard lê isto
  async handler() {
    const tenant = (tryCtx() as { tenant?: { id: string } })?.tenant?.id ?? null
    return { ok: true, tenant }
  },
})

const app = await createApp({ plugins: [meuPlugin, expressPlugin({ routes: [secure] })] }).boot()
app.container.get(EXPRESS).listen(3000)
```

Sem `Authorization` → `401 AUTH_REQUIRED`; com o cabeçalho `x-tenant-id: acme` o handler vê `tenant: 'acme'` via contexto.

### Plugins de borda neutros

Importam-se do `@machize/http` e funcionam no Express sem alterações:

```ts
import { createApp } from '@machize/core'
import { healthPlugin, metricsPlugin, route, securityPlugin } from '@machize/http'
import { EXPRESS, expressPlugin } from '@machize/express'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

const app = await createApp({
  plugins: [
    expressPlugin({ routes: [ping] }),
    securityPlugin({ rateLimit: { limit: 100, windowMs: 60_000 } }), // cabeçalhos seguros + 429 acima do limite
    healthPlugin({ checks: { db: () => ({ ok: true }) } }),          // GET /livez e /readyz
    metricsPlugin(),                                                  // GET /metrics (Prometheus)
  ],
}).boot()
app.container.get(EXPRESS).listen(3000)
```

Todas as opções destes plugins estão documentadas no README do [`@machize/http`](../http/README.md).

### Trazer a tua própria app Express

Se já tens uma app Express com middleware próprio, passa-a ao plugin:

```ts
import express from 'express'
import { expressPlugin } from '@machize/express'

const minhaApp = express()
// ... middleware teu aqui ...
expressPlugin({ app: minhaApp, routes: [] })
// Nota: o plugin adiciona express.json() na mesma.
```

### Avançado: `registerRoutes()` sem o plugin

Monta rotas Machize numa app Express diretamente, sem ciclo de vida Machize:

```ts
import express from 'express'
import { route } from '@machize/http'
import { registerRoutes } from '@machize/express'

const app = express()
app.use(express.json()) // sem o plugin, o parsing de JSON é responsabilidade tua
const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })
registerRoutes(app, [ping]) // container, enrichers e guards são opcionais
app.listen(3000)
```

Neste modo cada handler já trata os próprios erros (o wrapper responde com `toErrorResponse`), mas não há edge plugins nem registo de rotas para OpenAPI/CLI.

## Referência da API

### `expressPlugin(options?)` → plugin Machize (`machize:express`)

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `routes` | `MachizeRoute[]` | Não | `[]` | Rotas (criadas com `route()` do `@machize/http`) a montar. |
| `app` | `Express` | Não | `express()` novo | Trazes a tua app Express; em ambos os casos `express.json()` é adicionado. |

Comportamento: regista a app Express no token `EXPRESS` e um `HttpServerCollector` no token `HTTP_SERVER`. No evento `app:booted` monta tudo pela ordem que o Express exige: middleware de *after-hooks* (métricas/tracing, via `res.on('finish')`) → middleware de *pre-hooks* (segurança/CORS/rate limit; se um deles responder, a rota não corre) → rotas Machize → rotas extra dos edge plugins (`/livez`, `/metrics`, …). Publica as rotas no bucket de metadados `'http:routes'` para OpenAPI/CLI/SDK.

> Nota: ao contrário do `fastifyPlugin`, este plugin não tem passo de `shutdown` — fechar o servidor HTTP devolvido por `listen()` é responsabilidade tua.

### `EXPRESS`

Token de injeção de dependências (`Token<Express>`): `app.container.get(EXPRESS)` devolve a app Express para chamares `listen(porta)` ou adicionares middleware.

### `registerRoutes(app, routes, container?, enrichers?, guards?)`

| Parâmetro | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `app` | `Express` | Sim | — | App Express onde montar. |
| `routes` | `MachizeRoute[]` | Sim | — | Rotas a montar. |
| `container` | `Container` | Não | — | Contentor DI; sem ele não há scope por pedido nem enrichers/guards. |
| `enrichers` | `RequestEnricher[]` | Não | `[]` | Funções que enriquecem o contexto antes dos guards. |
| `guards` | `RouteGuard[]` | Não | `[]` | Funções que podem rejeitar o pedido (lançando um erro). |

### O que importar de onde

Este pacote exporta apenas `expressPlugin`, `registerRoutes`, `EXPRESS` e `ExpressPluginOptions`. Tudo o resto — `route`, `HttpError`, `RequestValidationError`, `securityPlugin`, `healthPlugin`, `metricsPlugin`, `tracingPlugin`, `openapiPlugin`, tipos como `RequestEnricher`/`RouteGuard` — importa-se do **`@machize/http`**.

## Erros comuns e soluções (FAQ)

**"`Cannot find module 'express'`."** O Express é *peer dependency*: `pnpm add express`.

**"O `body` chega `undefined` no handler."** O cliente tem de enviar o cabeçalho `Content-Type: application/json`; sem ele o `express.json()` não interpreta o corpo.

**"Tentei `import { route } from '@machize/express'` e falhou."** A função `route()` não é exportada por este pacote — importa-a de `@machize/http` (é neutra de propósito: a mesma rota corre em Fastify e Hono).

**"400 `HTTP_VALIDATION` num GET com query correta."** Na query do Express tudo chega como texto — usa `z.coerce.number()` / `z.coerce.boolean()` nos esquemas.

**"Os edge plugins não respondem (`/metrics` dá 404)."** São montados no evento `app:booted`: garante que chamas `await createApp({...}).boot()` antes de `listen()` e que o `expressPlugin` está na lista de plugins (é ele que regista o `HTTP_SERVER`).

**"Como fecho o servidor num teste?"** Guarda o retorno de `listen()`: `const server = app.container.get(EXPRESS).listen(0)` e no fim `server.close()` seguido de `await app.shutdown()`.

## Como se liga aos outros módulos

- **`@machize/core`** — o `expressPlugin` é um plugin Machize (`definePlugin`) no ciclo de vida `createApp → boot`; usa o `Container` (tokens `EXPRESS`, `HTTP_SERVER`), os buckets de metadados e o contexto por pedido (`ctx()`/`tryCtx()`), que fica disponível em qualquer profundidade do código.
- **`@machize/http`** — fornece `route()`, o pipeline `runRoute()` (validação, enrichers, guards), `toErrorResponse()` e os edge plugins. Este adaptador limita-se a converter `Request`/`Response` do Express no `HttpRequest`/`HttpReply` neutro.
- **`@machize/fastify` / `@machize/hono`** — adaptadores irmãos: as mesmas rotas, enrichers, guards e edge plugins correm em qualquer um deles sem alterações; trocar de framework é trocar de plugin.
- **`@machize/auth` / `@machize/tenancy` / `@machize/permissions`** — registam guards/enrichers em `'http:guards'`/`'http:enrichers'` e leem o `meta` das rotas (ex.: `meta: { auth: true }`); este adaptador aplica-os automaticamente.
- **`@machize/sdk` e a CLI** — consomem o bucket `'http:routes'` (rotas + esquemas Zod) que este plugin publica.
