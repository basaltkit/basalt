# @machize/core

A fundação do framework Machize: o "motor" que arranca a tua aplicação, liga as peças umas às outras (plugins), guarda os serviços partilhados (container) e mantém o contexto de cada pedido. Precisas dele sempre que crias uma aplicação Machize — todos os outros pacotes `@machize/*` assentam neste.

## O que este módulo resolve

Quando uma aplicação cresce, passa a ter muitas peças: base de dados, e-mail, filas de trabalho, autenticação, etc. Sem organização, cada peça liga-se às outras "à mão" e torna-se difícil saber por que ordem devem arrancar, como partilham objetos entre si e como se desligam corretamente quando a aplicação termina. O `@machize/core` resolve exatamente isso.

A ideia central é o **plugin**: um pequeno módulo com um nome (por exemplo `machize:cache`) que sabe registar os seus serviços, arrancar e desligar-se. A aplicação (`createApp`) recebe uma lista de plugins, ordena-os automaticamente pelas dependências declaradas e executa o ciclo de vida completo: registar → arrancar → (mais tarde) desligar, pela ordem certa.

Para os plugins partilharem serviços sem se conhecerem diretamente, existe o **container de injeção de dependências** (em inglês *dependency injection*, ou DI): uma "caixa" onde um plugin coloca um serviço identificado por um **token** (uma chave com tipo) e qualquer outro plugin o vai buscar por esse token. O pacote inclui ainda: **hooks** (avisos internos entre plugins), **contexto por pedido** (dados como o `requestId` disponíveis em qualquer ponto do código), **métricas** no formato Prometheus e **tracing** (rastreio de operações) compatível com OpenTelemetry — tudo sem dependências externas.

## Instalação

```bash
pnpm add @machize/core
```

Requisitos: Node.js (usa `node:async_hooks` e `node:crypto`) e TypeScript. O pacote é ESM (`"type": "module"`).

## Começar em 5 minutos

Vamos criar uma aplicação com dois plugins: um fornece um serviço de saudação e o outro usa-o.

1. Cria um token para identificar o serviço.
2. Cria um plugin que regista o serviço no container.
3. Cria um segundo plugin que depende do primeiro e usa o serviço.
4. Arranca a aplicação.

```ts
import { createApp, createToken, definePlugin } from '@machize/core'

// 1. O token é a "etiqueta com tipo" do serviço no container.
interface Greeter {
  greet(name: string): string
}
const GREETER = createToken<Greeter>('greeter')

// 2. Plugin que fornece o serviço (fase register: só regista, sem I/O).
const greeterPlugin = definePlugin({
  name: 'app:greeter',
  register({ container }) {
    container.singleton(GREETER, () => ({
      greet: (name) => `Olá, ${name}!`,
    }))
  },
})

// 3. Plugin que consome o serviço (fase boot: já pode usar tudo).
const helloPlugin = definePlugin({
  name: 'app:hello',
  dependsOn: ['app:greeter'], // garante a ordem de arranque
  boot({ container }) {
    console.log(container.get(GREETER).greet('Machize'))
  },
})

// 4. Arranque e paragem.
const app = await createApp({ plugins: [greeterPlugin, helloPlugin] }).boot()
// ... a aplicação corre ...
await app.shutdown()
```

Ao correr, imprime `Olá, Machize!`. Repara que a ordem no array não importa: o `dependsOn` garante que `app:greeter` regista e arranca antes de `app:hello`.

## Guia de utilização

### Plugins e ciclo de vida

Um plugin é um objeto simples com um nome e até três funções de ciclo de vida, todas opcionais:

- `register(context)` — fase 1: colocar serviços no container. Sem efeitos externos (sem ligações de rede, sem ficheiros).
- `boot(context)` — fase 2: ligar a bases de dados, subscrever hooks, iniciar recursos.
- `shutdown(context)` — desligar de forma limpa. Corre pela **ordem inversa** do arranque; se um plugin falhar ao desligar, os restantes desligam na mesma e os erros são agregados num `AggregateError`.

O `context` recebido em cada fase tem três campos: `container`, `hooks` e `config` (a fatia de configuração do plugin, já validada — ver abaixo).

```ts
import { definePlugin } from '@machize/core'

const dbPlugin = definePlugin({
  name: 'app:db',
  register({ container }) {
    /* registar bindings */
  },
  async boot() {
    /* ligar à base de dados */
  },
  async shutdown() {
    /* fechar a ligação */
  },
})
```

### Configuração validada por plugin

Cada plugin pode declarar um `configSchema` (um "schema" é uma descrição do formato esperado dos dados, para validação). Qualquer objeto com um método `safeParse` serve — os schemas da biblioteca [Zod](https://zod.dev) são compatíveis. No arranque, a fatia `config[nomeDoPlugin]` é validada; se falhar, o `boot()` lança `ConfigValidationError` imediatamente (falha cedo, antes de a aplicação servir pedidos).

```ts
import { createApp, definePlugin } from '@machize/core'
import { z } from 'zod'

const cachePlugin = definePlugin<{ driver: string }>({
  name: 'machize:cache',
  configSchema: z.object({ driver: z.string() }),
  boot({ config }) {
    console.log(`Cache com driver: ${config.driver}`) // config já tipada e validada
  },
})

await createApp({
  plugins: [cachePlugin],
  config: { 'machize:cache': { driver: 'memory' } }, // chaveado pelo nome do plugin
}).boot()
```

### Container de injeção de dependências

O container guarda "receitas" (*factories*: funções que criam o serviço) associadas a tokens. Há três tempos de vida (`Lifetime`):

- `singleton` — uma única instância para toda a aplicação (é o valor por omissão).
- `scoped` — uma instância por âmbito (por exemplo, por pedido HTTP), criada com `createScope()`.
- `transient` — uma instância nova em cada `get()`.

```ts
import { Container, createToken } from '@machize/core'

const COUNTER = createToken<{ n: number }>('counter')
const NAME = createToken<string>('name')

const container = new Container()
container.singleton(NAME, () => 'Machize')
// A factory recebe o container — é assim que se injetam dependências:
container.singleton(COUNTER, (c) => ({ n: c.get(NAME).length }))

console.log(container.get(COUNTER).n) // 7

// Âmbitos (por exemplo, um por pedido):
container.scoped(COUNTER, () => ({ n: 0 }))
const scopeA = container.createScope()
const scopeB = container.createScope()
scopeA.get(COUNTER).n = 10 // não afeta o scopeB
```

O container deteta ciclos (A precisa de B que precisa de A) e lança `CircularDependencyError` com a cadeia completa; um token não registado lança `UnknownTokenError`.

### Hooks (avisos entre plugins)

O `HookBus` permite que um plugin anuncie acontecimentos ("hooks") e outros reajam, sem se importarem uns aos outros. A própria aplicação emite `app:registered`, `app:booted` e `app:shutdown`.

```ts
import { HookBus } from '@machize/core'

const hooks = new HookBus()

// Handler com prioridade: valores maiores correm primeiro (por omissão 0).
const off = hooks.on('app:booted', ({ app }) => {
  console.log('A aplicação arrancou!')
}, { priority: 10 })

// Ouve TODAS as emissões (útil para auditoria/devtools); corre depois dos específicos.
hooks.onAny((hook, payload) => console.log(`hook: ${hook}`))

await hooks.emit('app:booted', { app })
off() // cancelar a subscrição
```

Pacotes podem acrescentar hooks tipados via *module augmentation* (Avançado):

```ts
declare module '@machize/core' {
  interface MachizeHooks {
    'tenancy:switched': { tenantId: string }
  }
}
```

### Contexto por pedido (`ctx`)

O contexto transporta dados de um pedido (como `requestId`) por toda a pilha de chamadas, mesmo através de `await`, sem passares argumentos manualmente. Usa `AsyncLocalStorage` do Node.

```ts
import { ctx, runWithContext, tryCtx } from '@machize/core'

async function servicoProfundo(): Promise<string> {
  // funciona a qualquer profundidade, sem receber o id por parâmetro:
  return ctx().requestId as string
}

const resultado = await runWithContext({ requestId: 'req-1' }, async () => {
  return servicoProfundo()
})
console.log(resultado) // 'req-1'

// Fora de um contexto ativo: ctx() lança ContextUnavailableError; tryCtx() devolve undefined.
console.log(tryCtx()) // undefined
```

Contextos concorrentes não se misturam: cada `runWithContext` tem o seu.

### Durações legíveis

```ts
import { parseDuration } from '@machize/core'

parseDuration('30s')  // 30000 (milissegundos)
parseDuration('1.5d') // 129600000
parseDuration(1500)   // 1500 (números passam diretamente)
// 'abc', '-5s', NaN → lança MachizeError com code 'DURATION_INVALID'
```

Unidades aceites: `ms`, `s`, `m`, `h`, `d`.

### Métricas (formato Prometheus)

Contadores, medidores e histogramas que se exportam em texto no formato do [Prometheus](https://prometheus.io) (um sistema popular de monitorização) — o suficiente para um endpoint `/metrics`.

```ts
import { MetricsRegistry } from '@machize/core'

const registry = new MetricsRegistry()

const requests = registry.counter('http_requests_total', {
  help: 'Total de pedidos HTTP',
  labelNames: ['method'],
})
requests.inc({ method: 'GET' })
requests.inc({ method: 'GET' })

const inFlight = registry.gauge('in_flight')
inFlight.inc() // sobe
inFlight.dec() // desce
inFlight.set(42)

const duration = registry.histogram('request_duration_seconds', {
  buckets: [0.1, 0.5, 1],
})
duration.observe(0.2)

console.log(registry.render()) // texto pronto para o endpoint /metrics
```

Pedir uma métrica com o mesmo nome devolve sempre a mesma instância. Contadores rejeitam incrementos negativos.

### Tracing (rastreio distribuído)

*Tracing* é registar quanto tempo demorou cada operação (um *span*) e como se encadeiam entre serviços. A implementação segue a norma W3C `traceparent` e exporta para qualquer coletor OpenTelemetry via OTLP/HTTP — sem instalar o SDK da OpenTelemetry.

```ts
import { ConsoleSpanExporter, Tracer } from '@machize/core'

const tracer = new Tracer({
  serviceName: 'a-minha-api',
  exporter: new ConsoleSpanExporter(), // imprime um resumo por span
})

const span = tracer.startSpan('GET /users', { kind: 'server' })
await tracer.inSpan(span, async () => {
  // spans criados aqui dentro tornam-se filhos automaticamente
  const child = tracer.startSpan('db.query')
  child.setAttribute('db.table', 'users')
  child.end()
})
// inSpan termina o span, e marca status 'error' se a função lançar
```

Para produção, usa o `OtlpHttpExporter` (envia para `http://<coletor>:4318/v1/traces` em lotes) e, para continuar um trace vindo de outro serviço, `parseTraceparent(headers['traceparent'])` como `parent` do span.

## Referência da API

### `createToken<T>(description)` / `Token<T>`

Cria um token de DI tipado. O tipo `T` só existe em tempo de compilação (não há reflexão em runtime). Dois tokens com a mesma descrição são **diferentes** (cada um tem o seu `symbol`).

### `Container`

| Método | Descrição |
|---|---|
| `register(token, factory, lifetime?)` | Regista uma factory. `lifetime` por omissão: `'singleton'`. Devolve `this`. |
| `singleton(token, factory)` | Atalho para `register(..., 'singleton')`. |
| `scoped(token, factory)` | Uma instância por âmbito (criada no container folha). |
| `transient(token, factory)` | Instância nova a cada resolução. |
| `get(token)` | Resolve o serviço. Lança `UnknownTokenError` ou `CircularDependencyError`. |
| `has(token)` | `true` se existir binding (aqui ou no container pai). |
| `createScope()` | Cria um container filho: herda bindings, não herda instâncias `scoped`. |

`Factory<T>` = `(container: Container) => T`. `Lifetime` = `'singleton' | 'scoped' | 'transient'`.

### `definePlugin(plugin)` / `MachizePlugin<TConfig>`

`definePlugin` apenas devolve o objeto com tipagem — é açúcar para autocompletar.

| Campo | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `name` | `string` | sim | — | Nome único; convenção `machize:<pacote>` ou `app:<nome>`. |
| `dependsOn` | `string[]` | não | `[]` | Plugins que registam/arrancam antes deste. |
| `configSchema` | `ConfigSchema<TConfig>` | não | — | Objeto com `safeParse` (compatível com Zod); valida a fatia de config. |
| `register` | `(ctx) => void \| Promise<void>` | não | — | Fase 1: registar bindings, sem I/O. |
| `boot` | `(ctx) => void \| Promise<void>` | não | — | Fase 2: ligar recursos, subscrever hooks. |
| `shutdown` | `(ctx) => void \| Promise<void>` | não | — | Desligar; corre por ordem inversa. |

`PluginContext<TConfig>` = `{ container, hooks, config }`.

### `createApp(options)` / `MachizeApp`

| Opção (`CreateAppOptions`) | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `plugins` | `MachizePlugin[]` | não | `[]` | Plugins; ordenados topologicamente por `dependsOn`. |
| `config` | `Record<string, unknown>` | não | `{}` | Config em bruto, chaveada pelo nome de cada plugin. |

Membros de `MachizeApp`: `container`, `hooks`, `phase` (`LifecyclePhase` = `'created' | 'registering' | 'booting' | 'ready' | 'shutting-down' | 'stopped'`), `boot()` (só pode ser chamado uma vez; senão lança `LifecycleError`) e `shutdown()` (idempotente). Hooks emitidos: `app:registered`, `app:booted`, `app:shutdown`.

### `HookBus`

| Método | Descrição |
|---|---|
| `on(hook, handler, { priority? })` | Subscreve; `priority` maior corre primeiro (default 0). Devolve função para cancelar. |
| `onAny(handler)` | Recebe `(hook, payload)` de todas as emissões, depois dos específicos. |
| `emit(hook, payload)` | Executa os handlers **em série** por prioridade; `await`-a cada um. |

### Contexto

| Função | Descrição |
|---|---|
| `ctx()` | Contexto ativo (`RequestContext`); lança `ContextUnavailableError` fora de um âmbito. |
| `tryCtx()` | Contexto ativo ou `undefined`. |
| `runWithContext(context, fn)` | Executa `fn` com o contexto ativo (propaga por `await`s e callbacks). |

`RequestContext` tem `requestId?`, `correlationId?` e aceita chaves extra (extensível por *module augmentation*).

### `parseDuration(input)`

`DurationInput` = `number | string`. Converte para milissegundos; lança `MachizeError` (`DURATION_INVALID`) se inválido.

### Erros

Todos estendem `MachizeError`, que tem um `code` estável (podes fazer `if (error.code === '...')` com segurança):

| Classe | `code` |
|---|---|
| `ContextUnavailableError` | `CONTEXT_UNAVAILABLE` |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` |
| `CircularDependencyError` | `DI_CIRCULAR_DEPENDENCY` |
| `PluginDependencyError` | `PLUGIN_DEPENDENCY` |
| `ConfigValidationError` (campos `plugin`, `issues`) | `CONFIG_INVALID` |
| `LifecycleError` | `LIFECYCLE` |

### Métricas

- `MetricsRegistry`: `counter(name, options?)`, `gauge(name, options?)`, `histogram(name, options? & { buckets? })`, `render()`.
- `MetricOptions`: `help?` (default: o próprio nome), `labelNames?` (default `[]`).
- `Counter.inc(labels?, value?)` — `value` default 1, nunca negativo.
- `Gauge.set(value, labels?)`, `inc(labels?, value?)`, `dec(labels?, value?)`.
- `Histogram.observe(value, labels?)`; `buckets` default `DEFAULT_BUCKETS` (`[0.005 … 10]` segundos).
- `Metric` (classe abstrata) e `Labels` = `Record<string, string>`.

### Tracing

- `Tracer(options?)` — `TracerOptions`: `exporter?`, `serviceName?` (default `'machize'`), `sampled?` (default `true`), `clock?` (default `Date.now`), `idGenerator?`.
- `tracer.startSpan(name, { parent?, kind?, attributes? })` — `kind` default `'internal'`; sem `parent`, usa o span ativo como pai.
- `tracer.inSpan(span, fn)` — ativa o span, marca `error` se `fn` lançar, termina-o sempre.
- `tracer.forceFlush()` — força o envio do exportador.
- `Span`: `setAttribute(key, value)`, `setStatus(status, message?)`, `end()` (idempotente).
- `activeSpan()` — o span em curso ou `undefined`.
- `parseTraceparent(header)` / `formatTraceparent(context)` — cabeçalho W3C.
- Exportadores (`SpanExporter`): `InMemorySpanExporter` (testes), `ConsoleSpanExporter` (dev), `OtlpHttpExporter` (`OtlpHttpExporterOptions`: `url` obrigatório, `serviceName?`, `headers?`, `maxBatch?` default 100, `fetchImpl?`). O envio é *best-effort*: falhas de rede nunca quebram o pedido.
- `toOtlpJson(spans, serviceName)` (Avançado) — serializa para o formato OTLP/JSON.
- Tipos: `SpanContext`, `FinishedSpan`, `SpanKind`, `SpanStatus`, `AttributeValue`.

### Metadados (Avançado)

`MetadataRegistry` (`add(bucket, entry)`, `get(bucket)`, `bucketNames()`), token `METADATA` e `ensureMetadata(container)` — registo central do que cada plugin declarou (rotas, comandos, agendamentos), lido por ferramentas (CLI, docs) sem importarem o pacote produtor.

## Erros comuns e soluções (FAQ)

**"No provider registered for token …" (`DI_UNKNOWN_TOKEN`)** — Fizeste `container.get(TOKEN)` mas nenhum plugin registou esse token. Verifica se o plugin que o fornece está na lista de `plugins` e se o consumidor tem `dependsOn` para ele.

**"ctx() was called outside of an active context" (`CONTEXT_UNAVAILABLE`)** — Chamaste `ctx()` fora de `runWithContext`. Embrulha o ponto de entrada (handler HTTP, worker) com `runWithContext({...}, fn)` ou usa `tryCtx()` quando um contexto é opcional.

**"boot() called in phase …" (`LIFECYCLE`)** — `boot()` só pode ser chamado uma vez por aplicação. Cria uma nova app com `createApp()` se precisares de arrancar de novo (útil em testes).

**"Plugin X depends on Y, which was not added to the app" (`PLUGIN_DEPENDENCY`)** — Falta adicionar o plugin `Y` ao array `plugins`. O mesmo erro aparece para plugins duplicados e ciclos (`a -> b -> a`).

**"Invalid configuration for plugin …" (`CONFIG_INVALID`)** — A fatia `config['nome-do-plugin']` não passou no `configSchema`. Confirma que a chave no objeto `config` é exatamente o `name` do plugin.

**Dois tokens "iguais" comportam-se como diferentes** — É intencional: cada `createToken` cria um `symbol` novo. Exporta o token de um módulo partilhado e importa-o em todo o lado, em vez de o recriares.

## Como se liga aos outros módulos

- **`@machize/config`** — fornece o `configPlugin`, que regista um `ConfigRepository` no container do core através do token `CONFIG`.
- **`@machize/env`** — usa o `MachizeError` do core para o seu `EnvValidationError`; costuma ser o primeiro passo antes de montares o objeto `config` que passas ao `createApp`.
- **`@machize/events`** — fornece o `eventsPlugin` (bus de eventos no token `EVENTS`) e o `outboxPlugin`; ambos são plugins do core e o outbox usa `tryCtx()` para ler o tenant do contexto.
- Qualquer pacote do ecossistema estende os tipos `MachizeHooks` e `RequestContext` via *module augmentation* para acrescentar hooks e campos de contexto tipados.
