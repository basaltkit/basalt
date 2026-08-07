# @machize/http

Núcleo HTTP neutro do Machize: define rotas tipadas, valida os dados dos pedidos e trata erros de forma padronizada — o mesmo código funciona depois em Fastify, Express ou Hono. Precisas dele sempre que quiseres definir rotas ou usar os plugins de segurança, saúde, métricas, tracing e OpenAPI.

## O que este módulo resolve

Quando crias uma API (um servidor que responde a **pedidos HTTP** — as mensagens que um browser ou uma app enviam pela internet), normalmente escolhes um framework como o Fastify, o Express ou o Hono. O problema: cada um tem a sua própria maneira de definir **rotas** (os endereços a que o servidor responde, como `GET /users/:id`), de validar dados e de tratar erros. Se um dia mudares de framework, tens de reescrever tudo.

O `@machize/http` resolve isso: defines cada rota **uma única vez**, com a função `route()`, num formato neutro que não depende de nenhum framework. Depois, um **adaptador** (`@machize/fastify`, `@machize/express` ou `@machize/hono`) pega nessas rotas e liga-as ao framework escolhido. A validação dos dados é feita com [Zod](https://zod.dev) — uma biblioteca que descreve a forma dos dados (ex.: "o campo `name` é texto com pelo menos 3 letras") e os tipos TypeScript são deduzidos automaticamente.

Além das rotas, este módulo traz **plugins de borda** (edge plugins) prontos a usar em qualquer adaptador: cabeçalhos de segurança, limite de pedidos (rate limiting), CORS, sondas de saúde (`/livez`, `/readyz`), métricas Prometheus (`/metrics`), tracing distribuído e geração de documentação OpenAPI.

> **Nota**: na prática quase nunca usas o `@machize/http` sozinho — instalas também um adaptador. Este README explica os blocos que todos os adaptadores partilham.

## Instalação

```bash
pnpm add @machize/http zod
```

O `zod` é uma *peer dependency* (o módulo usa-o mas deixa-te escolher a versão). Precisas também de um adaptador para servir os pedidos, por exemplo `pnpm add @machize/fastify`.

## Começar em 5 minutos

Vamos definir uma rota tipada e servi-la com o adaptador Fastify.

**Passo 1** — instala os pacotes:

```bash
pnpm add @machize/core @machize/http @machize/fastify zod
```

**Passo 2** — cria um ficheiro `server.ts`:

```ts
import { createApp } from '@machize/core'
import { route } from '@machize/http'
import { FASTIFY, fastifyPlugin } from '@machize/fastify'
import { z } from 'zod'

// Uma rota: método + URL + validação + handler (a função que responde).
const hello = route({
  method: 'GET',
  url: '/hello/:name', // :name é um parâmetro dinâmico do URL
  params: z.object({ name: z.string() }),
  async handler({ params }) {
    // params.name já vem validado e tipado como string
    return { message: `Olá, ${params.name}!` }
  },
})

const app = await createApp({ plugins: [fastifyPlugin({ routes: [hello] })] }).boot()
await app.container.get(FASTIFY).listen({ port: 3000 })
console.log('A ouvir em http://localhost:3000')
```

**Passo 3** — executa e testa:

```bash
npx tsx server.ts
curl http://localhost:3000/hello/mundo
# → {"message":"Olá, mundo!"}
```

## Guia de utilização

### Definir rotas com `route()`

A função `route()` recebe um objeto de configuração e devolve uma definição de rota. Os tipos de `body`, `query` e `params` no handler são **inferidos** dos esquemas Zod — não escreves tipos à mão.

```ts
import { route, HttpError } from '@machize/http'
import { z } from 'zod'

const createProject = route({
  method: 'POST',
  url: '/projects',
  body: z.object({ name: z.string().min(3) }), // corpo do pedido (JSON)
  async handler({ body, reply }) {
    // reply permite controlar o estado HTTP e os cabeçalhos
    return reply.code(201).send({ id: 'p1', name: body.name })
  },
})

const getProject = route({
  method: 'GET',
  url: '/projects/:id',
  params: z.object({ id: z.string() }),
  query: z.object({ expand: z.coerce.boolean().default(false) }),
  async handler({ params, query }) {
    if (params.id === 'inexistente') {
      throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Projeto não encontrado')
    }
    return { id: params.id, expand: query.expand }
  },
})
```

Se a validação falhar, o cliente recebe automaticamente um `400` padronizado:

```json
{ "error": { "code": "HTTP_VALIDATION", "message": "Validation failed in body", "part": "body", "issues": [{ "path": "name", "message": "..." }] } }
```

### Lançar erros com `HttpError`

Em qualquer camada do código podes lançar um erro HTTP intencional; o adaptador converte-o na resposta certa, sem expor detalhes internos:

```ts
import { HttpError } from '@machize/http'

throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Projeto não encontrado')
// → resposta 404 com { error: { code: 'PROJECT_NOT_FOUND', message: '...' } }
```

Erros não intencionais (um `throw new Error(...)` qualquer) tornam-se num `500` genérico com o código `INTERNAL_ERROR` — a mensagem interna nunca chega ao cliente.

### Plugin de segurança — `securityPlugin()`

Aplica três proteções de borda em qualquer adaptador: cabeçalhos seguros, CORS e rate limiting (limitar quantos pedidos cada cliente pode fazer num intervalo de tempo).

```ts
import { createApp } from '@machize/core'
import { route, securityPlugin } from '@machize/http'
import { fastifyPlugin } from '@machize/fastify'

const ping = route({ method: 'GET', url: '/ping', async handler() { return { pong: true } } })

const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [ping] }),
    securityPlugin({
      // Cabeçalhos seguros ligados por omissão (HSTS, X-Frame-Options: DENY, etc.)
      headers: true,
      // CORS: só este domínio pode chamar a API a partir de um browser
      cors: { origin: ['https://app.example.com'], credentials: true },
      // Máximo de 100 pedidos por minuto por endereço IP
      rateLimit: { limit: 100, windowMs: 60_000 },
    }),
  ],
}).boot()
```

Quando o limite é excedido, o cliente recebe `429` com o código `RATE_LIMITED` e o cabeçalho `Retry-After`. O armazenamento por omissão é em memória (`MemoryRateLimitStore`); para vários servidores em cluster, implementa a interface `RateLimitStore` sobre Redis e passa-a em `rateLimit.store`.

### Sondas de saúde — `healthPlugin()`

Cria duas rotas ao estilo Kubernetes:

- `GET /livez` — "o processo está vivo?" Responde sempre `200`, sem tocar em dependências.
- `GET /readyz` — "está pronto para receber tráfego?" Corre todas as verificações; se alguma falhar responde `503` com o detalhe de cada uma.

```ts
import { healthPlugin } from '@machize/http'

healthPlugin({
  checks: {
    db: async () => ({ ok: true, detail: 'ligada' }),
    // Se a função lançar um erro, conta como { ok: false } com a mensagem do erro
  },
})
```

### Métricas Prometheus — `metricsPlugin()`

Serve `GET /metrics` em formato Prometheus e instrumenta automaticamente todos os pedidos HTTP (contador, histograma de duração e pedidos em curso), etiquetados pelo **template** da rota (`/users/:id`, não `/users/42`, para manter a cardinalidade controlada).

```ts
import { METRICS, metricsPlugin } from '@machize/http'

// nos plugins da app:
metricsPlugin()

// noutro sítio do código, para métricas próprias:
const registry = app.container.get(METRICS)
registry.counter('jobs_processed_total').inc()
```

### Tracing distribuído — `tracingPlugin()`

Regista um *span* de servidor por pedido (um registo de "esta operação demorou X ms"), continua um `traceparent` W3C recebido, devolve o cabeçalho `traceparent` na resposta e exporta os spans periodicamente.

```ts
import { tracingPlugin } from '@machize/http'
import { OtlpHttpExporter } from '@machize/core'

tracingPlugin({
  serviceName: 'minha-api',
  exporter: new OtlpHttpExporter({ url: 'http://localhost:4318/v1/traces' }),
})
```

### Documentação OpenAPI — `openapiPlugin()`

Gera um documento OpenAPI 3.0 a partir das rotas registadas (incluindo os esquemas Zod) e serve-o em `GET /openapi.json`:

```ts
import { openapiPlugin } from '@machize/http'

openapiPlugin({ info: { title: 'A Minha API', version: '1.0.0' } })
```

Rotas com `meta: { auth: true }` ficam marcadas com segurança `bearerAuth` no documento. O campo `response` da rota (esquemas por código de estado) alimenta as respostas documentadas.

### Avançado: `runRoute()` e o pipeline

Os adaptadores usam `runRoute()` para executar cada pedido: cria o contexto do pedido (`requestId`, `correlationId`, um *scope* do contentor de dependências), corre os **enrichers** (funções que enriquecem o contexto, ex.: resolver o tenant), depois os **guards** (funções que podem rejeitar o pedido, ex.: autenticação — rejeitam lançando um erro), valida `body`/`query`/`params` e por fim chama o handler. Só precisas disto se fores escrever o teu próprio adaptador.

```ts
import { Container } from '@machize/core'
import { route, runRoute, toErrorResponse } from '@machize/http'

const resultado = await runRoute(definicao, pedidoNeutro, respostaNeutra, {
  container: new Container(),
  enrichers: [],
  guards: [],
})
```

## Referência da API

### `route(config)` → `MachizeRoute`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `method` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'HEAD' \| 'OPTIONS'` | Sim | — | Método HTTP. |
| `url` | `string` | Sim | — | Caminho, com parâmetros `:nome`. |
| `body` | `ZodType` | Não | `undefined` | Esquema do corpo do pedido; validado em runtime. |
| `query` | `ZodType` | Não | `undefined` | Esquema da query string; validado em runtime. |
| `params` | `ZodType` | Não | `undefined` | Esquema dos parâmetros do URL; validado em runtime. |
| `response` | `Record<number, ZodType>` | Não | `undefined` | Esquemas de resposta por estado — só para OpenAPI/SDK, não validados em runtime. |
| `meta` | `Record<string, unknown>` | Não | `undefined` | Metadados livres lidos por outros plugins (ex.: `auth`, permissões). |
| `handler` | `(args) => unknown` | Sim | — | Recebe `{ body, query, params, request, reply }`; o valor devolvido é enviado como resposta (JSON), salvo se já respondeste com `reply.send()`. |

### Erros

| Export | Descrição |
|---|---|
| `HttpError(status, code, message)` | Erro HTTP intencional lançável de qualquer camada; vira resposta com esse `status`. |
| `RequestValidationError` | Lançado pelo pipeline quando a validação falha; vira `400` com `part` e `issues`. |
| `ValidationIssue` | Tipo `{ path: string; message: string }`. |

### Pipeline (Avançado — usado pelos adaptadores)

| Export | Descrição |
|---|---|
| `runRoute(definition, request, reply, pipeline?)` | Executa o pipeline completo de um pedido; devolve o valor do handler. |
| `toErrorResponse(error)` → `ErrorResponse` | Converte qualquer erro em `{ status, body }` padronizado. |
| `RequestEnricher` | `(info: { request, context, container }) => void \| Promise<void>` — corre antes dos guards. Regista-se no bucket de metadados `'http:enrichers'`. |
| `RouteGuard` | `(info: { route, request, context, container }) => void \| Promise<void>` — rejeita lançando. Bucket `'http:guards'`. |
| `RoutePipeline` | `{ container?, enrichers?, guards? }`. |

### Servidor neutro (Avançado — usado pelos adaptadores e edge plugins)

| Export | Descrição |
|---|---|
| `HTTP_SERVER` | Token DI da superfície neutra `HttpServer` que cada adaptador regista. |
| `HttpServer` | `use(preHook)`, `after(afterHook)`, `addRoute(method, url, handler)`. |
| `HttpServerCollector` | Implementação que acumula hooks/rotas para o adaptador montar no arranque (`runPre`, `runAfter`). |
| `PreHook` / `AfterHook` / `SimpleHandler` | Tipos dos hooks e das rotas autónomas. |

### `securityPlugin(options?)`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `headers` | `SecurityHeadersOptions \| boolean` | Não | `true` | Cabeçalhos seguros. `false` desliga. |
| `cors` | `CorsOptions \| false` | Não | desligado | CORS + resposta a preflight `OPTIONS` (204). |
| `rateLimit` | `RateLimitOptions \| false` | Não | desligado | Rate limiting com cabeçalhos `X-RateLimit-*`. |

`SecurityHeadersOptions`: `hsts` (default ligado, `max-age=15552000; includeSubDomains`), `contentTypeOptions` (default `true` → `nosniff`), `frameOptions` (default `'DENY'`), `referrerPolicy` (default `'no-referrer'`), `crossOriginOpenerPolicy` (default `'same-origin'`), `contentSecurityPolicy` (default desligado).

`CorsOptions`: `origin` (`boolean | string | string[] | (origin) => boolean`; default reflete qualquer origem), `methods` (default `GET, POST, PUT, PATCH, DELETE, OPTIONS`), `allowedHeaders`, `exposedHeaders`, `credentials`, `maxAge` (default `600`).

`RateLimitOptions`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `limit` | `number` | Sim | — | Máximo de pedidos por janela. |
| `windowMs` | `number` | Sim | — | Duração da janela em milissegundos. |
| `store` | `RateLimitStore` | Não | `new MemoryRateLimitStore()` | Armazenamento dos contadores. |
| `key` | `(request) => string` | Não | IP do cliente | Chave de agregação (ex.: por utilizador). |
| `skip` | `(request) => boolean` | Não | — | Devolve `true` para isentar o pedido. |

`MemoryRateLimitStore(clock?)` implementa `RateLimitStore` (`hit(key, limit, windowMs)` → `RateLimitResult { allowed, limit, remaining, resetAt, retryAfterMs }`; `reset(key)`).

### `healthPlugin(options?)`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `checks` | `Record<string, HealthCheck>` | Não | `{}` | Verificações; `HealthCheck` devolve `{ ok, detail? }` (ou promessa). |
| `livePath` | `string` | Não | `'/livez'` | Caminho da sonda de vida. |
| `readyPath` | `string` | Não | `'/readyz'` | Caminho da sonda de prontidão. |

### `metricsPlugin(options?)`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `path` | `string` | Não | `'/metrics'` | Caminho do endpoint Prometheus. |
| `registry` | `MetricsRegistry` | Não | novo registry | Registry partilhado (também exposto no token `METRICS`). |
| `instrumentHttp` | `boolean` | Não | `true` | Instrumenta pedidos (`http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`). |

### `tracingPlugin(options?)`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `serviceName` | `string` | Não | default do `Tracer` | Nome do serviço nos spans. |
| `exporter` | `SpanExporter` | Não | — | Destino dos spans (ex.: `OtlpHttpExporter`, `InMemorySpanExporter` do `@machize/core`). |
| `tracer` | `Tracer` | Não | criado internamente | Tracer próprio (ignora `exporter`/`serviceName`). |
| `flushIntervalMs` | `number` | Não | `5000` | Intervalo de exportação. O tracer também é exposto no token `TRACER`. |

### `openapiPlugin(options)` / `generateOpenApi(routes, info)` / `zodToJsonSchema(schema)`

| Opção (`OpenApiPluginOptions`) | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `info` | `OpenApiInfo` (`{ title, version, description? }`) | Sim | — | Metadados do documento. |
| `path` | `string` | Não | `'/openapi.json'` | Onde servir o documento. |
| `routes` | `RouteLike[]` | Não | rotas do bucket `'http:routes'` | Rotas a documentar. |

`generateOpenApi(routes, info)` devolve o documento OpenAPI 3.0.3 como objeto. `zodToJsonSchema(schema)` (Avançado) converte um subconjunto de Zod em JSON Schema; tipos desconhecidos degradam para `{}` sem lançar erro.

## Erros comuns e soluções (FAQ)

**"Defini rotas mas nada responde."** O `@machize/http` não abre portas de rede — precisa de um adaptador (`@machize/fastify`, `@machize/express` ou `@machize/hono`) que ligue as rotas a um servidor real.

**"A resposta é 400 com `HTTP_VALIDATION` e eu enviei os dados certos."** Vê o array `issues` na resposta: indica o campo (`path`) e o motivo. Em `query` e `params` tudo chega como texto — usa `z.coerce.number()` / `z.coerce.boolean()` para converter.

**"O rate limit não funciona com vários servidores."** O `MemoryRateLimitStore` vive na memória de cada processo. Implementa `RateLimitStore` sobre Redis e passa em `rateLimit.store`.

**"O meu erro personalizado sai como 500 genérico."** Só `HttpError` (ou um `MachizeError` com propriedade numérica `status`) mapeia para o estado que escolheste; qualquer outro erro vira `INTERNAL_ERROR` de propósito, para não expor detalhes internos.

**"`/readyz` responde 503."** Alguma verificação devolveu `ok: false` ou lançou um erro; o corpo da resposta traz o detalhe por verificação em `checks`.

## Como se liga aos outros módulos

- **`@machize/core`** — fornece a base que este módulo usa: `createApp`/plugins (`definePlugin`), contentor de injeção de dependências (`Container`, tokens), contexto por pedido (`ctx()`/`runWithContext`), `MetricsRegistry`, `Tracer` e `MachizeError`.
- **`@machize/fastify` / `@machize/express` / `@machize/hono`** — os adaptadores: convertem o pedido nativo do framework no `HttpRequest`/`HttpReply` neutro, chamam `runRoute()` e registam um `HttpServer` no token `HTTP_SERVER` para os edge plugins deste módulo funcionarem em qualquer um deles sem alterações.
- **Plugins de funcionalidade** (`@machize/auth`, `@machize/tenancy`, `@machize/permissions`, …) — integram-se pelo pipeline: registam *enrichers* no bucket de metadados `'http:enrichers'` e *guards* em `'http:guards'`, e leem o `meta` das rotas (ex.: `meta: { auth: true }`).
- **Ferramentas** (CLI `mach routes`, OpenAPI, `@machize/sdk`) — leem as rotas expostas pelos adaptadores no bucket `'http:routes'`, com os esquemas Zod incluídos.
