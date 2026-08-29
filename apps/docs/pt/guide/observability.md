# Observabilidade

Métricas, sondas de saúde, tracing distribuído e logging estruturado vêm
incluídos — sem bibliotecas de cliente, sem exporters a instalar, sem SDK do
OpenTelemetry. Cada um é um plugin, e cada um assenta na **costura
`HTTP_SERVER`, neutra face à framework**, em vez de no Fastify, por isso as
mesmas quatro linhas funcionam em Fastify, Express e Hono. Usa esta página
quando precisares de responder a "está de pé?", "quão rápido está?" e "o que
aconteceu a *este* pedido?" em produção.

[[toc]]

## Modelo mental

Quatro plugins, quatro perguntas, um mecanismo partilhado:

| Plugin | Responde | Regista | Token |
| --- | --- | --- | --- |
| `metricsPlugin` | Quanto, quão rápido, quantos em voo? | `GET /metrics` + um par de hooks pre/after | `METRICS` |
| `healthPlugin` | O processo está de pé? Está pronto para tráfego? | `GET /livez`, `GET /readyz` | — |
| `tracingPlugin` | Onde é que *este* pedido gastou o tempo, entre serviços? | um par de hooks pre/after + um temporizador de flush | `TRACER` |
| `loggerPlugin` | O que aconteceu, com que identificadores? | nada de HTTP | `LOGGER` |

Os três primeiros resolvem `HTTP_SERVER` no seu `boot()` e registam-lhe hooks e
rotas; o adaptador (`fastifyPlugin` / `expressPlugin` / `honoPlugin`) fornece esse
token e monta tudo o que recolheu no `app:booted`. Como o **`register` de cada
plugin corre antes do `boot` de qualquer plugin**, a ordem deles no array
`plugins` é irrelevante — mas um adaptador tem de estar presente, e tens de
chamar `boot()`.

`metricsPlugin`, `healthPlugin`, `tracingPlugin`, `METRICS` e `TRACER` vivem em
**`@basaltkit/http`**, e o `@basaltkit/fastify` re-exporta-os por conveniência —
em Express e Hono importa-os diretamente de `@basaltkit/http`; os plugins em si
são idênticos. As primitivas de métricas e spans (`Counter`, `Gauge`,
`Histogram`, `Tracer`, os exporters) vêm de `@basaltkit/core`. O `loggerPlugin` é
o seu próprio pacote, `@basaltkit/logger`, e não precisa de adaptador nenhum.

## Ligar tudo em conjunto

```ts
// src/app.ts
import { createApp, OtlpHttpExporter } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY, metricsPlugin, healthPlugin, tracingPlugin } from '@basaltkit/fastify'
import { loggerPlugin } from '@basaltkit/logger'

export const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [/* as tuas rotas */] }),
    loggerPlugin({ level: 'info', base: { service: 'acme-api' } }),
    metricsPlugin(),                                        // GET /metrics
    healthPlugin({ checks: { db: () => ({ ok: pool.isHealthy() }) } }), // GET /livez, /readyz
    tracingPlugin({
      serviceName: 'acme-api',
      // define serviceName também no exporter — é esse que o OTLP reporta
      exporter: new OtlpHttpExporter({ url: 'http://otel-collector:4318', serviceName: 'acme-api' }),
    }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

::: warning Os plugins de borda precisam do adaptador
O `metricsPlugin`, o `healthPlugin` e o `tracingPlugin` resolvem `HTTP_SERVER`
durante o `boot()`. Sem um adaptador registado, essa resolução lança
`UnknownTokenError` (`DI_UNKNOWN_TOKEN`) e a app **recusa arrancar** — uma falha
ruidosa em vez de um `/metrics` silenciosamente ausente. E sem `boot()`, nada é
montado de todo.
:::

::: danger Não exponhas as sondas à internet
O `/metrics` revela a tua tabela de rotas, a forma do tráfego e as taxas de erro;
o `/readyz` revela que dependências estão em baixo. Nenhum é autenticado. Liga-os
a uma interface interna, restringe-os no ingress, ou tira-os do caminho público
com `metricsPlugin({ path })` / `healthPlugin({ readyPath })`. Vê
[Segurança](/pt/guide/security).
:::

## Métricas — `metricsPlugin`

Expõe um endpoint Prometheus e auto-instrumenta cada pedido:

```ts
import { metricsPlugin } from '@basaltkit/fastify'

metricsPlugin() // serve GET /metrics como text/plain; version=0.0.4
```

Logo à partida obténs:

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram | `method`, `route` |
| `http_requests_in_flight` | gauge | — |

Os pedidos são rotulados pelo **template de rota** que o adaptador reporta
(`/users/:id`), nunca pelo URL em bruto, por isso a cardinalidade dos labels
mantém-se limitada. Um pedido que não correspondeu a nenhuma rota é rotulado
`unknown` — um único bucket, não uma série por URL 404. O histograma usa o
conjunto de buckets predefinido (`0,005 … 10` segundos); o
`http_requests_in_flight` é incrementado num pre-hook e decrementado no
after-hook, por isso também conta pedidos ainda a ser servidos.

Passa `instrumentHttp: false` para manteres o endpoint e largares as séries HTTP
automáticas, ou `registry` para partilhares um `MetricsRegistry` com código que
corre fora do caminho do pedido (workers, [filas](/pt/guide/queues)).

### Métricas personalizadas

Resolve o registry através do `METRICS` e regista as tuas próprias — são
renderizadas no mesmo endpoint. O registry é um get-or-create por nome, por isso
chamar `counter()` duas vezes com o mesmo nome devolve o mesmo instrumento em vez
de o substituir:

```ts
import { METRICS } from '@basaltkit/fastify'

const jobs = container.get(METRICS).counter('jobs_processed_total', {
  help: 'Background jobs processed',
  labelNames: ['queue'],
})
jobs.inc({ queue: 'emails' })

// os histogramas aceitam buckets explícitos quando as predefinições não servem
const render = container.get(METRICS).histogram('render_seconds', {
  help: 'Template render time',
  buckets: [0.001, 0.005, 0.02, 0.1],
})
render.observe(0.004)
```

`Counter`, `Gauge` e `Histogram` também são exportados de `@basaltkit/core` para
uso em qualquer lado — renderizam o formato de exposição de texto Prometheus
diretamente. Mantém os `labelNames` poucos e limitados: um label cujo valor seja
um id de utilizador ou um URL é a causa habitual de um backend de métricas ir
abaixo.

## Sondas de saúde — `healthPlugin`

Liveness e readiness são **deliberadamente distintas**, e falham de forma
diferente:

```ts
import { healthPlugin } from '@basaltkit/fastify'

healthPlugin({
  checks: {
    db: () => ({ ok: pool.isHealthy(), detail: 'primary' }),
    redis: async () => ({ ok: await redis.ping().then(() => true).catch(() => false) }),
  },
})
```

- **`GET /livez`** — devolve `{ "status": "ok" }` incondicionalmente. Nunca toca
  numa dependência, por isso uma base de dados lenta não pode desencadear um loop
  de reinício.
- **`GET /readyz`** — corre todos os checks **em paralelo** e devolve `200` só se
  todos passarem; caso contrário `503` com uma discriminação por check, para que
  um load balancer drene a instância em vez de lhe enviar tráfego.

```json
// GET /readyz  → 503
{ "status": "unavailable", "checks": { "db": { "ok": false }, "redis": { "ok": true } } }
```

::: tip O `detail` é para os teus logs, nunca para a resposta da sonda
Um check pode devolver `{ ok, detail }`, mas **só o `ok` é serializado** — o corpo
da resposta leva passa/falha por check e mais nada. Um check que *lança* é
apanhado, registado no servidor como
`[basalt:health] readiness check "<name>" failed:` com a causa, e reportado como
`{ ok: false }`. Ambas as regras existem para que uma sonda não autenticada não
possa ser transformada num endpoint de reconhecimento que vaza fragmentos de DSN,
hostnames ou portos.
:::

Mantém os checks baratos e limitados — correm em cada sonda, e um check sem
timeout próprio mantém o `/readyz` aberto durante todo o tempo em que a
dependência pendurar.

## Tracing distribuído — `tracingPlugin`

Tracing zero-dependências que fala W3C trace-context e exporta OTLP/JSON para
qualquer collector OpenTelemetry — sem OTel SDK necessário.

```ts
import { tracingPlugin } from '@basaltkit/fastify'
import { OtlpHttpExporter } from '@basaltkit/core'

tracingPlugin({
  serviceName: 'acme-api',
  exporter: new OtlpHttpExporter({
    url: 'http://otel-collector:4318',   // o /v1/traces é acrescentado por ti
    serviceName: 'acme-api',
    headers: { authorization: `Bearer ${process.env.OTEL_TOKEN}` },
    maxBatch: 100,
  }),
  flushIntervalMs: 5000,
})
```

Por pedido, o plugin continua um `traceparent` de entrada (ou inicia um novo
trace), regista um **span de servidor** chamado `${method} ${templateDeRota}` com
os atributos `http.method` / `http.target`, ecoa `traceparent` na resposta, e no
fim define `http.status_code`, marca o span como `error` para `5xx` e `ok` caso
contrário, e termina-o. Os spans concluídos são acumulados e enviados a cada
`flushIntervalMs` (o temporizador tem `unref()`) mais uma vez no `app.shutdown()`.

::: warning O `serviceName` define-se em dois sítios
O `tracingPlugin({ serviceName })` nomeia o **`Tracer`**. O nome que de facto
aterra no `resource.service.name` do payload OTLP vem do `serviceName` do
**exporter**, cuja predefinição é `'basalt'`. Define-o nos dois, ou os teus spans
chegam ao collector atribuídos a `basalt`.
:::

Resolve o `TRACER` para envolver o teu próprio trabalho em spans — o `inSpan`
coloca o span em `AsyncLocalStorage`, por isso tudo o que arranque lá dentro é
automaticamente um filho:

```ts
import { TRACER } from '@basaltkit/fastify'

const tracer = container.get(TRACER)
await tracer.inSpan(tracer.startSpan('charge.capture', { kind: 'client' }), async () => {
  await gateway.capture(/* … */)
})
```

Para desenvolvimento local troca por `ConsoleSpanExporter` (uma linha por span);
em testes, `InMemorySpanExporter` recolhe spans para asserções — vê
[Testes](/pt/guide/testing). As falhas de exportação são engolidas de propósito: o
tracing nunca pode partir o caminho do pedido, por isso um collector morto
custa-te spans, não pedidos.

## Logging — `loggerPlugin`

O `@basaltkit/logger` envolve o Pino: logs JSON estruturados, campos de contexto
por pedido injetados automaticamente, e redação de segredos ligada por
predefinição.

```ts
import { loggerPlugin, LOGGER } from '@basaltkit/logger'

loggerPlugin({
  level: 'info',            // um de LOG_LEVELS; 'silent' desliga o logging
  pretty: true,             // saída legível para dev (precisa de pino-pretty)
  redact: ['user.ssn'],     // caminhos extra, somados às predefinições
  base: { service: 'api' }, // campos fixos em cada linha
})

// em qualquer lado:
container.get(LOGGER).info({ orderId }, 'order placed')
```

Cada linha leva automaticamente o que o [contexto](/pt/guide/concepts) ativo
tiver: `requestId`, `correlationId`, `traceId`, `userId` e `tenantId` — mais
`tenant.id` / `user.id` promovidos a `tenantId` / `userId` quando só os objetos
estão definidos. Nunca os passas numa chamada de log. Fora de um contexto (um log
de boot, um script) o mixin não contribui com nada em vez de lançar.

::: tip A redação está ligada por predefinição, e não é só `password`
Os valores são substituídos por `[REDACTED]` para `password`, `pass`, `secret`,
`token`, `accessToken`, `refreshToken`, `idToken`, `jwt`, `apiKey`, `api_key`,
`apikey`, `mfaCode`, `otp`, `resetToken`, `authorization`, `cookie`,
`creditCard`, `cardNumber`, `cvv`, `cvc` e `ssn` — no nível de topo **e** num
nível de aninhamento (`*.token`), mais os caminhos habituais em forma de pedido
(`req.headers.authorization`, `headers["set-cookie"]`, …). O `redact`
**acrescenta** a essa lista; nunca a substitui. Qualquer coisa mais funda do que
um nível precisa de um caminho explícito.
:::

Os corpos de email são um problema à parte com um interruptor à parte: o driver
`log` do mailer redige os corpos das mensagens em produção porque levam links de
reset e magic links. Isso é o `logBody` no `mailerPlugin`, não uma opção do
logger — vê [Notificações](/pt/guide/notifications).

### Os níveis de log são tipados

O `level` é a união **`LogLevel`** — não uma string livre — por isso um erro de
escrita **não compila**. Do mais para o menos severo:

`'fatal'` · `'error'` · `'warn'` · `'info'` (default) · `'debug'` · `'trace'` · `'silent'`

Reutiliza o mesmo tipo e valores (`LogLevel` / `LOG_LEVELS`) nas tuas próprias
opções e na validação do env, para um nível errado ser apanhado no código **e** no
boot:

```ts
import { z } from 'zod'
import { defineEnv } from '@basaltkit/env'
import { LOG_LEVELS, type LogLevel } from '@basaltkit/logger'

// env — um LOG_LEVEL inválido é rejeitado no arranque
const env = defineEnv({ LOG_LEVEL: z.enum(LOG_LEVELS).default('info') })

// a tua própria opção — um nível inválido é erro de compilação
interface BuildAppOptions { logLevel?: LogLevel }
```

O `'silent'` desliga toda a saída — útil para comandos de CLI e testes. Faz parte
do `LogLevel` (o tipo `Level` do próprio Pino omite-o). Vê
[Configuração](/pt/guide/config) para a canalização do env.

## Correlação de pedidos

Cada pedido carrega um `requestId` e um `correlationId` no
[contexto](/pt/guide/concepts), o que significa que aparecem em cada linha de log
e podem ser propagados entre serviços. Reencaminha os cabeçalhos `x-request-id` /
`x-correlation-id` de entrada nas chamadas de saída e um identificador acompanha
uma ação do utilizador em cada salto; junta-lhe o `traceparent` que o
`tracingPlugin` ecoa e consegues saltar de uma linha de log para o trace.

Os mesmos identificadores são o que torna legíveis as superfícies assíncronas:
põe o teu logger por trás dos callbacks `onBridgeError` / `onDeliveryError` do
realtime ([Realtime](/pt/guide/realtime)), do `onDead` / `onFlushError` do outbox
([Persistence](/pt/guide/persistence)) e do `onError` / `onJobFailed` das filas
([Filas](/pt/guide/queues)) em vez de os deixares no `console.error`.

## Referência de opções

`metricsPlugin(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `path` | `string` | `'/metrics'` | Tira o endpoint de scrape de um caminho que o teu ingress exponha publicamente |
| `registry` | `MetricsRegistry` | um novo | Partilha um registry com código fora do HTTP (workers, jobs) para tudo renderizar num só endpoint |
| `instrumentHttp` | `boolean` | `true` | `false` mantém o `/metrics` mas larga as séries `http_*` automáticas |

Instrumentos do `MetricsRegistry` — `counter(name, opts)`, `gauge(name, opts)`,
`histogram(name, opts)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `help` | `string` | o nome da métrica | A linha `# HELP` na exposição |
| `labelNames` | `string[]` | `[]` | Chaves de label declaradas; mantém o espaço de valores limitado |
| `buckets` | `number[]` | `DEFAULT_BUCKETS` (`0,005 … 10`) | Só histogramas — ajusta ao teu intervalo real de latências |

`healthPlugin(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `checks` | `Record<string, () => HealthReport \| Promise<HealthReport>>` | `{}` | Checks de readiness, corridos em paralelo; um report é `{ ok, detail? }` e só o `ok` é serializado |
| `livePath` | `string` | `'/livez'` | Corresponde ao caminho da sonda de liveness do teu orquestrador |
| `readyPath` | `string` | `'/readyz'` | Corresponde ao caminho da sonda de readiness do teu orquestrador |

`tracingPlugin(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'basalt'` | Nomeia o `Tracer`. O `service.name` do OTLP vem do **exporter** — define os dois |
| `exporter` | `SpanExporter` | nenhum | Para onde vão os spans concluídos; sem um, os spans são registados e descartados |
| `tracer` | `Tracer` | construído com as opções acima | Traz o teu próprio `Tracer` (amostragem, relógio, gerador de ids) |
| `flushIntervalMs` | `number` | `5000` | Cadência de exportação; o temporizador tem `unref()` e há um flush final no encerramento |

`new OtlpHttpExporter(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `url` | `string` | — (**obrigatório**) | URL base do collector; o `/v1/traces` é acrescentado e a barra final removida |
| `serviceName` | `string` | `'basalt'` | O `resource.service.name` reportado ao collector |
| `headers` | `Record<string, string>` | `{}` | Autenticação para um collector alojado |
| `maxBatch` | `number` | `100` | Faz flush assim que o buffer atinge este tamanho |
| `fetchImpl` | `typeof fetch` | `fetch` global | Injeta um cliente (proxy, testes) |

`new Tracer(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `exporter` | `SpanExporter` | nenhum | Destino dos spans concluídos |
| `serviceName` | `string` | `'basalt'` | Nome levado pelo tracer |
| `sampled` | `boolean` | `true` | `false` emite `traceflags: 00`, dizendo aos serviços a jusante para não amostrarem |
| `clock` | `() => number` | `Date.now` | Relógio injetável (testes) |
| `idGenerator` | `{ traceId(): string; spanId(): string }` | hex aleatório | Ids determinísticos em testes |

`loggerPlugin(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `level` | `LogLevel` | `'info'` | Severidade mínima; `'silent'` desliga a saída por completo |
| `pretty` | `boolean` | `false` | Saída legível para dev — requer o `pino-pretty` instalado |
| `redact` | `string[]` | `[]` | Caminhos **somados** à lista de redação embutida, para os teus próprios campos com segredos |
| `base` | `Bindings` | `{}` | Campos fixos em cada linha (`service`, `version`, região…) |
| `destination` | `DestinationStream` | stdout | Encaminha a saída para outro sítio — um ficheiro, um transport, um buffer de teste |

## Modos de falha e resolução de problemas

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | boot | `metricsPlugin` / `healthPlugin` / `tracingPlugin` registados sem adaptador, ou `METRICS` / `TRACER` / `LOGGER` resolvidos sem o seu plugin |
| — (falha de readiness) | — | 503 | Um ou mais checks do `/readyz` devolveram `ok: false` **ou lançaram**; o corpo diz quais |
| Check lançou | registado `[basalt:health] readiness check "<name>" failed:` | 503 | A causa fica só no servidor — a resposta diz `{ ok: false }` e mais nada |
| `Error: unable to determine transport target for "pino-pretty"` | — | boot | `pretty: true` sem o `pino-pretty` instalado |
| Perda silenciosa de spans | — | — | O exporter OTLP engole erros de transporte por design; um collector morto custa spans, nunca pedidos |

- **O `/metrics` devolve 404** — não foi registado adaptador nenhum, o `boot()`
  nunca foi chamado, ou o `path` foi alterado. A *ordem* dos plugins não é a
  causa: cada `register` corre antes de qualquer `boot`.
- **Os spans chegam atribuídos a `basalt`** — o `serviceName` foi definido no
  `tracingPlugin` mas não no exporter. É o `serviceName` do exporter que preenche
  o `resource.service.name`.
- **Os traces param na fronteira do serviço** — quem chamou não reencaminhou o
  `traceparent`. O plugin ecoa-o nas respostas, mas os pedidos de saída são da tua
  responsabilidade.
- **O Prometheus vai abaixo depois de um deploy** — um novo label leva um valor
  ilimitado (id de utilizador, caminho, mensagem de erro). As séries HTTP
  embutidas são seguras porque usam o template de rota; os instrumentos
  personalizados não são policiados.
- **As linhas de log não têm `tenantId`/`userId`** — o log foi emitido fora de um
  contexto de pedido, ou a tenancy/auth ainda não o tinham preenchido. O mixin só
  contribui com o que o contexto já tem.
- **Apareceu um segredo nos logs** — estava aninhado a mais de um nível, ou a
  chave não está na lista predefinida. Acrescenta o caminho explícito com
  `redact`; e se era um corpo de email, isso é o `logBody` do mailer, em
  [Notificações](/pt/guide/notifications).
- **O `/readyz` fica pendurado** — um check não tem timeout próprio. Envolve as
  dependências lentas com um; o `healthPlugin` aguarda o que lhe deres.

Para a checklist de deployment que junta tudo isto, vê
[Ir para Produção](/pt/guide/production).
