# @machize/fastify

Adaptador oficial do Machize para [Fastify](https://fastify.dev): pega nas rotas tipadas do Machize e serve-as num servidor Fastify, com contexto por pedido, erros padronizados e um plugin de idempotência. Precisas dele quando queres construir uma API HTTP em Node.js com o Machize usando o Fastify como motor.

## O que este módulo resolve

Um servidor HTTP é o programa que recebe **pedidos HTTP** (as mensagens que um browser ou uma app enviam, como "dá-me o utilizador 42") e devolve respostas. O [Fastify](https://fastify.dev) é um dos servidores mais rápidos do ecossistema Node.js — mas, sozinho, não valida dados, não tipa os handlers e cada projeto inventa o seu formato de erros.

Este módulo liga o Fastify ao Machize. Defines cada **rota** (um endereço + método, ex.: `POST /projects`) com a função `route()` e esquemas [Zod](https://zod.dev); o adaptador trata do resto: valida o corpo, a query e os parâmetros do URL, cria um contexto por pedido (com `requestId` acessível em qualquer ponto do código, mesmo em funções profundas, via `ctx()`), e converte erros em respostas JSON com um formato estável — sem nunca expor mensagens internas num `500`.

Como a definição de rotas é neutra (vem do `@machize/http`), o mesmo código de rotas corre também nos adaptadores Express e Hono. E os plugins de borda (segurança, saúde, métricas, tracing, OpenAPI) são re-exportados aqui por conveniência. O extra exclusivo deste adaptador é o `idempotencyPlugin`: repetições seguras de pedidos que alteram dados (ex.: nunca cobrar um cartão duas vezes).

## Instalação

```bash
pnpm add @machize/fastify @machize/core zod
```

O Fastify já vem como dependência deste pacote — não precisas de o instalar à parte. O `zod` (versão 3 ou 4) é *peer dependency*.

## Começar em 5 minutos

**Passo 1** — instala os pacotes (comando acima).

**Passo 2** — cria um ficheiro `server.ts` com uma rota e o arranque do servidor:

```ts
import { createApp } from '@machize/core'
import { FASTIFY, fastifyPlugin, route } from '@machize/fastify'
import { z } from 'zod'

// 1. Definir a rota: método, URL, validação e handler (a função que responde).
const createProject = route({
  method: 'POST',
  url: '/projects',
  body: z.object({ name: z.string().min(3) }), // o corpo tem de ter um name com 3+ letras
  async handler({ body, reply }) {
    // body.name já está validado e tipado como string
    return reply.code(201).send({ id: 'p1', name: body.name })
  },
})

// 2. Criar a app Machize com o plugin Fastify e arrancar.
const app = await createApp({ plugins: [fastifyPlugin({ routes: [createProject] })] }).boot()

// 3. Obter a instância Fastify do contentor e pôr a ouvir numa porta.
await app.container.get(FASTIFY).listen({ port: 3000 })
console.log('A ouvir em http://localhost:3000')
```

**Passo 3** — executa e testa:

```bash
npx tsx server.ts
curl -X POST http://localhost:3000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Machize"}'
# → {"id":"p1","name":"Machize"}   (estado 201)

curl -X POST http://localhost:3000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"ab"}'
# → 400 {"error":{"code":"HTTP_VALIDATION","part":"body","issues":[...]}}
```

**Passo 4** — para desligar com limpeza (fecha o Fastify): `await app.shutdown()`.

## Guia de utilização

### Rotas tipadas com params, query e erros

```ts
import { HttpError, route } from '@machize/fastify'
import { z } from 'zod'

const getProject = route({
  method: 'GET',
  url: '/projects/:id', // :id é um parâmetro dinâmico
  params: z.object({ id: z.string() }),
  // Na query string tudo chega como texto; z.coerce converte
  query: z.object({ expand: z.coerce.boolean().default(false) }),
  async handler({ params, query }) {
    if (params.id === 'missing') {
      // Erro intencional: vira 404 com um código estável
      throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Projeto não encontrado')
    }
    return { id: params.id, expand: query.expand }
  },
})
```

Erros não intencionais (`throw new Error('segredo')`) respondem `500` com `INTERNAL_ERROR` — a mensagem interna é registada no log do Fastify, mas nunca enviada ao cliente.

### Contexto por pedido (`ctx()`)

Cada pedido corre dentro de um contexto (via `AsyncLocalStorage` do Node): em qualquer função, por mais funda que seja, podes ler o `requestId` sem o passares de argumento em argumento.

```ts
import { createApp, ctx } from '@machize/core'
import { fastifyPlugin, route } from '@machize/fastify'

async function servicoProfundo(): Promise<string> {
  return ctx().requestId as string // o mesmo id do pedido em curso
}

const whoami = route({
  method: 'GET',
  url: '/whoami',
  async handler() {
    return { requestId: ctx().requestId, viaService: await servicoProfundo() }
  },
})
```

Se o cliente enviar o cabeçalho `x-request-id`, esse valor é usado; caso contrário é gerado um UUID. A resposta devolve sempre `x-request-id`. Cada pedido recebe também um *scope* próprio do contentor de dependências (`ctx().container`) — instâncias registadas como `scoped` são novas por pedido.

### Idempotência — `idempotencyPlugin()` (exclusivo do Fastify)

Idempotência significa: repetir o mesmo pedido não repete o efeito. Quando o cliente envia o cabeçalho `Idempotency-Key`, a primeira resposta fica guardada; qualquer repetição com a mesma chave recebe **a mesma resposta**, sem executar o handler outra vez — uma nova tentativa de rede nunca cobra um cartão duas vezes.

```ts
import { createApp } from '@machize/core'
import { FASTIFY, fastifyPlugin, idempotencyPlugin, route } from '@machize/fastify'
import { z } from 'zod'

const charge = route({
  method: 'POST',
  url: '/charge',
  body: z.object({ amount: z.number() }),
  async handler({ body, reply }) {
    return reply.code(201).send({ charged: body.amount })
  },
})

const app = await createApp({
  plugins: [fastifyPlugin({ routes: [charge] }), idempotencyPlugin()],
}).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
```

```bash
curl -X POST http://localhost:3000/charge \
  -H 'content-type: application/json' \
  -H 'idempotency-key: abc-123' \
  -d '{"amount":10}'
# Repete o mesmo comando: mesma resposta, com o cabeçalho Idempotent-Replayed: true
```

Regras (verificadas nos testes do pacote):
- Repetição enquanto o primeiro pedido ainda está em curso → `409 IDEMPOTENCY_CONFLICT`.
- Respostas `>= 500` **não** são guardadas — falhas genuínas continuam a poder ser repetidas.
- As chaves são isoladas por método + rota: a mesma chave em dois endpoints não colide.
- Pedidos sem o cabeçalho não são afetados.

### Plugins de borda (segurança, saúde, métricas, tracing, OpenAPI)

São neutros (vivem no `@machize/http`) mas re-exportados aqui — podes importar tudo de `@machize/fastify`:

```ts
import { createApp } from '@machize/core'
import {
  FASTIFY,
  fastifyPlugin,
  healthPlugin,
  metricsPlugin,
  openapiPlugin,
  route,
  securityPlugin,
  tracingPlugin,
} from '@machize/fastify'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [ping] }),
    securityPlugin({ cors: { origin: ['https://app.example.com'] }, rateLimit: { limit: 100, windowMs: 60_000 } }),
    healthPlugin({ checks: { db: () => ({ ok: true }) } }), // GET /livez e /readyz
    metricsPlugin(),                                        // GET /metrics (Prometheus)
    tracingPlugin({ serviceName: 'minha-api' }),            // spans + cabeçalho traceparent
    openapiPlugin({ info: { title: 'A Minha API', version: '1.0.0' } }), // GET /openapi.json
  ],
}).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
```

A documentação detalhada de cada um (todas as opções) está no README do [`@machize/http`](../http/README.md).

### Avançado: `registerRoutes()` sem o plugin

Se já tens um servidor Fastify e só queres montar rotas Machize nele:

```ts
import Fastify from 'fastify'
import { registerRoutes, route } from '@machize/fastify'

const instance = Fastify()
const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })
registerRoutes(instance, [ping]) // container, enrichers e guards são opcionais
await instance.listen({ port: 3000 })
```

Nota: sem o plugin não há tratamento de erros padronizado (o `setErrorHandler` é instalado pelo `fastifyPlugin`), nem edge plugins, nem registo das rotas para OpenAPI/CLI.

### Opções do Fastify (logger, trustProxy, …)

```ts
fastifyPlugin({
  routes,
  fastify: { logger: true, trustProxy: true }, // passado tal e qual ao construtor Fastify()
})
```

## Referência da API

### `fastifyPlugin(options?)` → plugin Machize (`machize:fastify`)

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `routes` | `MachizeRoute[]` | Não | `[]` | Rotas (criadas com `route()`) a registar. |
| `fastify` | `FastifyServerOptions` | Não | `{}` | Opções passadas ao construtor `Fastify()` (logger, trustProxy, …). |

Comportamento: regista a instância Fastify no token `FASTIFY` e um `HttpServerCollector` no token `HTTP_SERVER`; no boot lê enrichers/guards dos buckets de metadados (`'http:enrichers'`, `'http:guards'`), regista as rotas, publica-as no bucket `'http:routes'` (para OpenAPI/CLI/SDK) e monta os hooks dos edge plugins no evento `app:booted`. No `shutdown` fecha o Fastify (`close()`).

### `FASTIFY`

Token de injeção de dependências (`Token<FastifyInstance>`): `app.container.get(FASTIFY)` devolve a instância Fastify para `listen()`, `inject()` (testes) ou configuração extra.

### `registerRoutes(instance, routes, container?, enrichers?, guards?)`

| Parâmetro | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `instance` | `FastifyInstance` | Sim | — | Servidor Fastify onde montar. |
| `routes` | `MachizeRoute[]` | Sim | — | Rotas a montar. |
| `container` | `Container` | Não | — | Contentor DI; sem ele não há scope por pedido nem enrichers/guards. |
| `enrichers` | `RequestEnricher[]` | Não | `[]` | Funções que enriquecem o contexto antes dos guards. |
| `guards` | `RouteGuard[]` | Não | `[]` | Funções que podem rejeitar o pedido (lançando um erro). |

### `idempotencyPlugin(options?)` → plugin Machize (`machize:idempotency`, depende de `machize:fastify`)

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `store` | `IdempotencyStore` | Não | `new MemoryIdempotencyStore(ttlMs)` | Onde guardar as respostas. |
| `header` | `string` | Não | `'idempotency-key'` | Cabeçalho que transporta a chave. |
| `methods` | `string[]` | Não | `['POST']` | Métodos protegidos. |
| `ttlMs` | `number` | Não | `86_400_000` (24 h) | Tempo de retenção de cada registo. |

`IdempotencyStore` (interface): `get(key)` → `IdempotencyRecord | 'pending' | undefined`; `setPending(key)`; `complete(key, record)`; `release(key)`. `IdempotencyRecord` = `{ status: number; body: string; contentType?: string }`. `MemoryIdempotencyStore(ttlMs?, clock?)` é a implementação em memória; para cluster, implementa a interface sobre Redis.

### Re-exports de `@machize/http`

Para conveniência (e retrocompatibilidade), este pacote re-exporta: `route`, `HttpError`, `RequestValidationError`, `securityPlugin`, `MemoryRateLimitStore`, `healthPlugin`, `metricsPlugin` + `METRICS`, `tracingPlugin` + `TRACER`, `openapiPlugin`, `generateOpenApi`, `zodToJsonSchema`, `HTTP_SERVER` e os tipos associados (`MachizeRoute`, `HandlerArgs`, `HttpMethod`, `HttpRequest`, `HttpReply`, `ValidationIssue`, `RequestEnricher`, `RouteGuard`, opções dos plugins, …). Consulta o README do `@machize/http` para as tabelas de opções.

## Erros comuns e soluções (FAQ)

**"`app.container.get(FASTIFY)` falha."** Só depois do `boot()`: `const app = await createApp({...}).boot()`. Confirma também que o `fastifyPlugin` está na lista de `plugins`.

**"Recebo 400 `HTTP_VALIDATION` num GET com query."** Na query string tudo chega como texto (`"true"`, `"42"`). Usa `z.coerce.boolean()` / `z.coerce.number()` no esquema.

**"O corpo chega `undefined`."** O cliente tem de enviar `Content-Type: application/json`; sem esse cabeçalho o Fastify não interpreta o JSON.

**"O idempotencyPlugin dá erro no boot."** Declara `dependsOn: ['machize:fastify']` — precisa do `fastifyPlugin` registado na mesma app.

**"Os edge plugins (metrics, health, …) não respondem."** Os hooks/rotas deles são montados no evento `app:booted` — garante que chamas `boot()` e que o `fastifyPlugin` está presente (é ele que regista o `HTTP_SERVER`).

**"Como testo sem abrir uma porta?"** Usa o `inject()` do Fastify: `await app.container.get(FASTIFY).inject({ method: 'GET', url: '/ping' })` — é assim que os testes deste pacote funcionam.

## Como se liga aos outros módulos

- **`@machize/core`** — o `fastifyPlugin` é um plugin Machize (`definePlugin`): vive no ciclo de vida `createApp → boot → shutdown`, usa o `Container` (tokens `FASTIFY` e `HTTP_SERVER`) e cria o `RequestContext` por pedido que alimenta `ctx()`/`tryCtx()`.
- **`@machize/http`** — todo o pipeline (validação, enrichers, guards, mapeamento de erros) vem daqui; este adaptador só converte o pedido/resposta do Fastify no formato neutro e chama `runRoute()`. As rotas definidas com `route()` correm sem alterações nos adaptadores Express e Hono.
- **`@machize/auth` / `@machize/tenancy` / `@machize/permissions`** — registam guards e enrichers nos buckets `'http:guards'`/`'http:enrichers'`, que este adaptador aplica a todas as rotas; leem o `meta` da rota (ex.: `meta: { auth: true }`).
- **`@machize/sdk` e a CLI (`mach routes`)** — leem as rotas publicadas no bucket `'http:routes'` (com os esquemas Zod) para gerar clientes e documentação, sem configuração duplicada.
