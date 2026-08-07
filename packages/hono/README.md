# @machize/hono

Adaptador do Machize para [Hono](https://hono.dev): as mesmas rotas tipadas, enrichers e guards que usarias no Fastify ou no Express, a correr em Hono — em Node.js, Bun, Deno ou plataformas *edge* (Cloudflare Workers, Vercel Edge, …). Precisas dele quando queres levar a tua API Machize para fora do Node clássico ou quando já usas Hono.

## O que este módulo resolve

O [Hono](https://hono.dev) é um framework web pequeno e muito rápido, construído sobre as APIs web standard (`Request`/`Response` do `fetch`). Por isso corre em quase todo o lado: Node.js, Bun, Deno e nos *edge runtimes* — servidores que executam o teu código em centenas de localizações perto dos utilizadores. Mas, tal como os outros frameworks, o Hono por si só não valida dados nem padroniza erros.

Este módulo liga o Hono ao Machize. As **rotas** (endereço + método HTTP, ex.: `POST /echo`) definem-se com a função `route()` do `@machize/http`, com esquemas [Zod](https://zod.dev) que validam o corpo, a query e os parâmetros do URL — e dão os tipos TypeScript de borla. O adaptador converte cada pedido do Hono para o formato neutro do Machize, corre o pipeline partilhado (validação, *enrichers* — funções que enriquecem o contexto do pedido — e *guards* — funções que podem recusá-lo, ex.: autenticação) e devolve respostas com erros em formato estável.

O ganho principal é a **portabilidade**: uma rota escrita aqui corre sem alterações no `@machize/fastify` e no `@machize/express`; e os plugins de borda neutros (segurança, saúde, métricas, tracing, OpenAPI) do `@machize/http` funcionam no Hono tal e qual.

## Instalação

```bash
pnpm add @machize/hono @machize/core @machize/http hono zod
```

O `hono` (versão 4+) é *peer dependency* — instala-lo tu. Para servir em Node.js precisas ainda de `pnpm add @hono/node-server`; em Bun, Deno ou edge não é preciso nada extra.

## Começar em 5 minutos

**Passo 1** — instala os pacotes (comando acima, mais `@hono/node-server` se estiveres em Node).

**Passo 2** — cria um ficheiro `server.ts`:

```ts
import { serve } from '@hono/node-server'
import { createApp } from '@machize/core'
import { route } from '@machize/http'
import { HONO, honoPlugin } from '@machize/hono'
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

// 2. Criar a app Machize com o plugin Hono e arrancar.
const app = await createApp({ plugins: [honoPlugin({ routes: [echo] })] }).boot()

// 3. Obter a app Hono do contentor e servi-la em Node.
serve({ fetch: app.container.get(HONO).fetch, port: 3000 })
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

**Num edge runtime** (Cloudflare Workers, Bun, Deno) exportas o `fetch` em vez de chamar `serve`:

```ts
const app = await createApp({ plugins: [honoPlugin({ routes: [echo] })] }).boot()
export default app.container.get(HONO) // o runtime chama .fetch por ti
```

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

Erros inesperados respondem `500` com `{ error: { code: 'INTERNAL_ERROR', ... } }` — o mesmo formato dos outros adaptadores, sem expor detalhes internos.

### Corpo do pedido: o que o adaptador interpreta

O adaptador lê o corpo consoante o `Content-Type`: `application/json` → objeto JSON; formulários (`form`) → `parseBody()` do Hono; outro texto → string; corpo vazio ou inválido → `undefined` (a validação Zod trata do resto). Pedidos `GET`/`HEAD` nunca têm corpo.

### Enrichers e guards (autenticação, tenancy, …)

Plugins registam estas funções nos "buckets" de metadados do contentor; o adaptador aplica-as a todas as rotas. Exemplo real (dos testes do pacote):

```ts
import { createApp, definePlugin, ensureMetadata, tryCtx } from '@machize/core'
import { HttpError, route, type RequestEnricher, type RouteGuard } from '@machize/http'
import { HONO, honoPlugin } from '@machize/hono'

// Enricher: anexa o tenant ao contexto do pedido.
const enricher: RequestEnricher = ({ request, context }) => {
  const tenant = request.headers['x-tenant-id']
  if (typeof tenant === 'string') (context as { tenant?: unknown }).tenant = { id: tenant }
}

// Guard: recusa o pedido lançando um erro; lê o meta da rota.
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

const app = await createApp({ plugins: [meuPlugin, honoPlugin({ routes: [secure] })] }).boot()
```

Sem `Authorization` → `401 AUTH_REQUIRED`; com `x-tenant-id: acme` o handler vê `tenant: 'acme'` através do contexto do pedido.

### Plugins de borda neutros

Importam-se do `@machize/http` e funcionam no Hono sem alterações:

```ts
import { createApp } from '@machize/core'
import { healthPlugin, metricsPlugin, route, securityPlugin } from '@machize/http'
import { HONO, honoPlugin } from '@machize/hono'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

const app = await createApp({
  plugins: [
    honoPlugin({ routes: [ping] }),
    securityPlugin({ rateLimit: { limit: 100, windowMs: 60_000 } }), // cabeçalhos seguros + 429 acima do limite
    healthPlugin({ checks: { db: () => ({ ok: true }) } }),          // GET /livez e /readyz
    metricsPlugin(),                                                  // GET /metrics (Prometheus)
  ],
}).boot()
```

Todas as opções destes plugins estão documentadas no README do [`@machize/http`](../http/README.md).

> Em edge runtimes distribuídos, lembra-te de que os stores em memória (rate limit, métricas) vivem por instância — usa stores partilhados (ex.: Redis/KV) quando precisares de valores globais.

### Testar sem abrir portas

Como o Hono fala `fetch`, testar é chamar `hono.fetch` com um `Request` normal — é assim que os testes deste pacote funcionam:

```ts
import { createApp } from '@machize/core'
import { route } from '@machize/http'
import { HONO, honoPlugin } from '@machize/hono'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })
const app = await createApp({ plugins: [honoPlugin({ routes: [ping] })] }).boot()
const hono = app.container.get(HONO)

const res = await hono.fetch(new Request('http://local/ping'))
console.log(res.status, await res.json()) // 200 { pong: true }
await app.shutdown()
```

### Avançado: `registerRoutes()` sem o plugin

Monta rotas Machize numa app Hono existente, sem ciclo de vida Machize:

```ts
import { Hono } from 'hono'
import { route } from '@machize/http'
import { registerRoutes } from '@machize/hono'

const app = new Hono()
const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })
registerRoutes(app, [ping]) // container, enrichers e guards são opcionais
export default app
```

Neste modo os erros continuam padronizados (cada handler embrulha `toErrorResponse`), mas não há edge plugins nem registo das rotas para OpenAPI/CLI.

## Referência da API

### `honoPlugin(options?)` → plugin Machize (`machize:hono`)

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `routes` | `MachizeRoute[]` | Não | `[]` | Rotas (criadas com `route()` do `@machize/http`) a montar. |
| `app` | `Hono` | Não | `new Hono()` | Trazes a tua app Hono; caso contrário é criada uma nova. |

Comportamento: regista a app Hono no token `HONO` e um `HttpServerCollector` no token `HTTP_SERVER`. No evento `app:booted` monta, por ordem: middleware de *after-hooks* (métricas/tracing, medindo a duração), middleware de *pre-hooks* (segurança/CORS/rate limit; se um deles responder, a rota não corre), as rotas Machize e as rotas extra dos edge plugins (`/livez`, `/metrics`, `/openapi.json`, …). Publica as rotas no bucket de metadados `'http:routes'` para OpenAPI/CLI/SDK.

> Nota: este plugin não tem passo de `shutdown` próprio — parar o servidor (`serve` do `@hono/node-server`, etc.) é responsabilidade tua.

### `HONO`

Token de injeção de dependências (`Token<Hono>`): `app.container.get(HONO)` devolve a app Hono — usa `hono.fetch` para servir (Node via `@hono/node-server`, ou exporta-a num edge runtime) e para testes.

### `registerRoutes(app, routes, container?, enrichers?, guards?)`

| Parâmetro | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `app` | `Hono` | Sim | — | App Hono onde montar. |
| `routes` | `MachizeRoute[]` | Sim | — | Rotas a montar (via `app.on(method, url, handler)`). |
| `container` | `Container` | Não | — | Contentor DI; sem ele não há scope por pedido nem enrichers/guards. |
| `enrichers` | `RequestEnricher[]` | Não | `[]` | Funções que enriquecem o contexto antes dos guards. |
| `guards` | `RouteGuard[]` | Não | `[]` | Funções que podem rejeitar o pedido (lançando um erro). |

### O que importar de onde

Este pacote exporta apenas `honoPlugin`, `registerRoutes`, `HONO` e `HonoPluginOptions`. Tudo o resto — `route`, `HttpError`, `RequestValidationError`, `securityPlugin`, `healthPlugin`, `metricsPlugin`, `tracingPlugin`, `openapiPlugin`, tipos como `RequestEnricher`/`RouteGuard` — importa-se do **`@machize/http`**.

## Erros comuns e soluções (FAQ)

**"`Cannot find module 'hono'`."** O Hono é *peer dependency*: `pnpm add hono`.

**"Em Node, nada responde."** O Hono não abre portas sozinho em Node — precisas de `@hono/node-server`: `serve({ fetch: hono.fetch, port: 3000 })`.

**"Tentei `import { route } from '@machize/hono'` e falhou."** A função `route()` não é exportada por este pacote — importa-a de `@machize/http` (é neutra de propósito: a mesma rota corre em Fastify e Express).

**"O `body` chega `undefined`."** Envia o cabeçalho `Content-Type: application/json`; sem ele o adaptador não interpreta o corpo como JSON. Nota também que `GET`/`HEAD` nunca têm corpo.

**"400 `HTTP_VALIDATION` num GET com query correta."** Na query tudo chega como texto — usa `z.coerce.number()` / `z.coerce.boolean()` nos esquemas.

**"Os edge plugins não respondem (`/metrics` dá 404)."** São montados no evento `app:booted`: garante que chamas `await createApp({...}).boot()` antes de servir, e que o `honoPlugin` está na lista de plugins (é ele que regista o `HTTP_SERVER`).

**"O rate limit reinicia do nada no edge."** Cada instância edge tem a sua memória; o `MemoryRateLimitStore` não é partilhado entre localizações. Implementa `RateLimitStore` sobre um armazenamento partilhado.

## Como se liga aos outros módulos

- **`@machize/core`** — o `honoPlugin` é um plugin Machize (`definePlugin`) no ciclo de vida `createApp → boot`; usa o `Container` (tokens `HONO`, `HTTP_SERVER`), os buckets de metadados e o contexto por pedido (`ctx()`/`tryCtx()`).
- **`@machize/http`** — fornece `route()`, o pipeline `runRoute()` (validação, enrichers, guards), `toErrorResponse()` e os edge plugins. Este adaptador converte o `Context` do Hono no `HttpRequest`/`HttpReply` neutro e transforma o resultado num `Response` web standard.
- **`@machize/fastify` / `@machize/express`** — adaptadores irmãos: as mesmas rotas, enrichers, guards e edge plugins correm em qualquer um sem alterações; mudar de framework (ou de runtime — Node → edge) é mudar de plugin.
- **`@machize/auth` / `@machize/tenancy` / `@machize/permissions`** — registam guards/enrichers em `'http:guards'`/`'http:enrichers'` e leem o `meta` das rotas (ex.: `meta: { auth: true }`); este adaptador aplica-os automaticamente.
- **`@machize/sdk` e a CLI** — consomem o bucket `'http:routes'` (rotas + esquemas Zod) que este plugin publica.
