# Observabilidade

Métricas, sondas de saúde e tracing distribuído vêm incluídos — sem bibliotecas
de cliente, sem exporters a instalar. Cada um é um plugin Basalt; montam os seus
hooks e rotas no boot, por isso precisam de `fastifyPlugin` (ou do adaptador
Express/Hono) presente e de `boot()` chamado.

[[toc]]

## Ligar tudo em conjunto

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { metricsPlugin, healthPlugin, tracingPlugin } from '@basaltkit/fastify'
import { OtlpHttpExporter } from '@basaltkit/core'

export const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [/* as tuas rotas */] }),
    metricsPlugin(),                                   // GET /metrics
    healthPlugin({ checks: { db: () => ({ ok: true }) } }), // GET /livez, /readyz
    tracingPlugin({
      serviceName: 'acme-api',
      exporter: new OtlpHttpExporter({ url: 'http://otel-collector:4318' }),
    }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

Cada plugin é detalhado abaixo. `metricsPlugin`, `healthPlugin`, `tracingPlugin`,
`METRICS` e `TRACER` são re-exportados de `@basaltkit/fastify` (vivem em
`@basaltkit/http`); as primitivas de métricas e spans e os exporters vêm de
`@basaltkit/core`.

::: warning Aviso
Os seus hooks e rotas são montados no evento `app:booted`, por isso `/metrics`,
`/readyz` e o tracing só respondem quando `fastifyPlugin` está presente e chamaste
`boot()`.
:::

## Métricas — `metricsPlugin`

Expõe um endpoint Prometheus `/metrics` e auto-instrumenta cada pedido.

```ts
import { metricsPlugin } from '@basaltkit/fastify'

metricsPlugin() // serve GET /metrics
```

Logo à partida obténs:

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram | `method`, `route` |
| `http_requests_in_flight` | gauge | — |

Os pedidos são rotulados pelo **template de rota** (`/users/:id`), nunca pelo URL
em bruto, por isso a cardinalidade dos labels mantém-se limitada.

### Métricas personalizadas

Resolve o registry através do token `METRICS` e regista as tuas próprias — são
renderizadas no mesmo endpoint `/metrics`.

```ts
import { METRICS } from '@basaltkit/fastify'

const jobs = container.get(METRICS).counter('jobs_processed_total', {
  help: 'Background jobs processed',
  labelNames: ['queue'],
})
jobs.inc({ queue: 'emails' })
```

`Counter`, `Gauge` e `Histogram` também são exportados de `@basaltkit/core` para
uso em qualquer lado — renderizam o formato de exposição de texto Prometheus
diretamente.

## Sondas de saúde — `healthPlugin`

Liveness e readiness são **deliberadamente distintas**:

```ts
import { healthPlugin } from '@basaltkit/fastify'

healthPlugin({
  checks: {
    db: () => ({ ok: pool.isHealthy(), detail: 'primary' }),
    redis: async () => ({ ok: await redis.ping().then(() => true).catch(() => false) }),
  },
})
```

- **`GET /livez`** — o processo está a correr. Nunca toca em dependências, por
  isso uma base de dados lenta não pode desencadear um loop de reinício.
- **`GET /readyz`** — todos os checks registados passam. Caso contrário devolve
  `503` com uma discriminação por check, para que um load balancer drene a
  instância em vez de lhe enviar tráfego.

```json
// GET /readyz  → 503
{ "status": "unavailable", "checks": { "db": { "ok": false, "detail": "primary" }, "redis": { "ok": true } } }
```

## Tracing distribuído — `tracingPlugin`

Tracing zero-dependências que fala W3C trace-context e exporta OTLP para qualquer
collector OpenTelemetry — sem OTel SDK necessário.

```ts
import { tracingPlugin } from '@basaltkit/fastify'
import { OtlpHttpExporter } from '@basaltkit/core'

tracingPlugin({
  serviceName: 'acme-api',
  exporter: new OtlpHttpExporter({ url: 'http://otel-collector:4318' }),
})
```

`url` é o URL base do collector — o caminho OTLP `/v1/traces` é acrescentado por
ti. Passa `headers` para um collector autenticado, e `maxBatch` (por omissão 100)
para afinar o flushing.

Por pedido, continua um `traceparent` de entrada (ou inicia um novo trace),
regista um **span de servidor** rotulado pelo template de rota com atributos HTTP
e status, ecoa `traceparent` na resposta, e exporta o span concluído. Resolve o
token `TRACER` para envolver o teu próprio trabalho em spans:

```ts
import { TRACER } from '@basaltkit/fastify'

const tracer = container.get(TRACER)
await tracer.inSpan(tracer.startSpan('charge.capture', { kind: 'client' }), async () => {
  await gateway.capture(...)
})
```

Para desenvolvimento local, troca por `ConsoleSpanExporter`; em testes,
`InMemorySpanExporter` recolhe spans para asserções.

## Logging — `loggerPlugin`

O `@basaltkit/logger` envolve o Pino: logs JSON estruturados, campos de contexto
por pedido (`requestId`, `tenantId`, `userId`…) injetados automaticamente, e
redação de segredos ligada por defeito.

```ts
import { loggerPlugin } from '@basaltkit/logger'

loggerPlugin({
  level: 'info',            // um de LOG_LEVELS; 'silent' desliga o logging
  pretty: true,             // saída legível para dev (precisa de pino-pretty)
  redact: ['user.ssn'],     // caminhos extra a redigir (além dos defaults)
  base: { service: 'api' }, // campos fixos em cada linha
})
```

### Os níveis de log são tipados

O `level` é a união **`LogLevel`** — não uma string livre — por isso um erro de
escrita **não compila**. Do mais para o menos severo:

`'fatal'` · `'error'` · `'warn'` · `'info'` (default) · `'debug'` · `'trace'` · `'silent'`

Reutiliza o mesmo tipo e valores (`LogLevel` / `LOG_LEVELS`) na tua própria opção
e na validação do env, para um nível errado ser apanhado no código **e** no boot:

```ts
import { z } from 'zod'
import { defineEnv } from '@basaltkit/env'
import { LOG_LEVELS, type LogLevel } from '@basaltkit/logger'

// env — um LOG_LEVEL inválido é rejeitado no arranque
const env = defineEnv({ LOG_LEVEL: z.enum(LOG_LEVELS).default('info') })

// a tua própria opção — um nível inválido é erro de compilação
interface BuildAppOptions { logLevel?: LogLevel }
```

::: tip 'silent'
O `'silent'` desliga toda a saída — útil para comandos de CLI e testes. Faz parte
do `LogLevel` (o tipo `Level` do próprio Pino omite-o).
:::

## Correlação de pedidos

Cada pedido também carrega um `requestId` e um `correlationId` no
[contexto](/pt/guide/concepts) e nos logs estruturados (`@basaltkit/logger`). Propaga
os cabeçalhos `x-request-id` / `x-correlation-id` de entrada entre serviços para
rastrear uma chamada de ponta a ponta.
