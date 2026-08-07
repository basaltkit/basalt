# @machize/events

O barramento de eventos do Machize: eventos de domínio tipados e validados com Zod, ouvintes com prioridade, padrões com wildcards e o padrão *transactional outbox* para entregas fiáveis ao exterior. Precisas dele quando queres que partes da aplicação reajam a acontecimentos ("encomenda criada", "fatura paga") sem se conhecerem umas às outras.

## O que este módulo resolve

À medida que uma aplicação cresce, um simples "criar encomenda" passa a implicar várias coisas: enviar e-mail, atualizar estatísticas, avisar outro sistema. Se o código da encomenda chamar tudo isso diretamente, fica gigante e frágil. A solução clássica são **eventos**: o código anuncia "aconteceu `order.created`" e quem estiver interessado subscreve e reage — sem acoplamento entre as partes.

O `@machize/events` dá-te um `EventBus` (barramento de eventos) com três garantias importantes. Primeiro, os eventos são **tipados e validados**: defines cada evento com `defineEvent`, opcionalmente com um **schema** (uma descrição validável do formato dos dados, por exemplo com a biblioteca Zod), e o payload é verificado antes de qualquer ouvinte correr. Segundo, os **ouvintes** (funções que reagem ao evento; em inglês *listeners*) correm por ordem de prioridade e todos correm mesmo que um deles falhe — os erros são agregados no fim. Terceiro, podes subscrever por **padrões com wildcards**: `order.*` apanha `order.created`, e `order.**` apanha também `order.payment.failed`.

Para comunicar com sistemas **externos** (webhooks, Kafka, …) o pacote inclui o **Outbox**: em vez de enviares o evento diretamente (e o perderes se a aplicação crashar a meio), gravas primeiro o evento num armazém durável e um "carteiro" entrega-o depois, com novas tentativas em caso de falha. A entrega é *at-least-once* (pelo menos uma vez): nada se perde entre "gravado" e "entregue".

## Instalação

```bash
pnpm add @machize/events
```

O `@machize/core` vem como dependência automática. O Zod é opcional (só se quiseres validar payloads): `pnpm add zod`.

## Começar em 5 minutos

1. Define um evento tipado.
2. Cria o barramento e subscreve o evento.
3. Emite o evento com um payload validado.

```ts
import { defineEvent, EventBus } from '@machize/events'
import { z } from 'zod'

// 1. Evento com schema: o payload é validado ao emitir.
const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

// 2. Barramento e subscrição (o handler recebe o payload tipado).
const bus = new EventBus()
bus.on(OrderCreated, ({ orderId }) => {
  console.log(`Nova encomenda: ${orderId}`)
})

// 3. Emitir — o TypeScript obriga ao payload certo.
await bus.emit(OrderCreated, { orderId: 'o-1' })
// Um payload inválido (ex.: orderId: 123) lança EventValidationError
// ANTES de qualquer ouvinte correr.
```

Numa aplicação Machize completa, usa o plugin em vez de criares o bus à mão:

```ts
import { createApp } from '@machize/core'
import { EVENTS, eventsPlugin } from '@machize/events'

const app = await createApp({ plugins: [eventsPlugin()] }).boot()
const bus = app.container.get(EVENTS) // o mesmo EventBus para toda a aplicação
```

## Guia de utilização

### Eventos sem payload

Se o evento não transporta dados, omite o schema e o tipo — o `emit` deixa de aceitar segundo argumento:

```ts
import { defineEvent, EventBus } from '@machize/events'

const AppBooted = defineEvent('app.booted')

const bus = new EventBus()
bus.on(AppBooted, () => console.log('Arrancou!'))
await bus.emit(AppBooted)
```

Também podes tipar sem validar: `defineEvent<{ amount: number }>('invoice.paid')` — tipagem em compilação, sem verificação em runtime.

### Wildcards: ouvir famílias de eventos

Os nomes de eventos usam segmentos separados por pontos. Nos padrões, `*` corresponde a **exatamente um** segmento e `**` a **um ou mais**:

```ts
import { defineEvent, EventBus } from '@machize/events'

const bus = new EventBus()

bus.on('order.*', (payload, meta) => {
  // apanha order.created, order.cancelled — mas NÃO order.payment.failed
  console.log(`um segmento: ${meta.name}`)
})
bus.on('order.**', (payload, meta) => {
  // apanha order.created E order.payment.failed
  console.log(`qualquer sufixo: ${meta.name}`)
})
bus.on('**', (payload, meta) => {
  // apanha tudo — útil para logging/auditoria
  console.log(`global: ${meta.name}`)
})

await bus.emit(defineEvent('order.payment.failed'))
```

O segundo argumento do handler, `meta`, traz o nome real do evento (`meta.name`) — essencial nos padrões.

### Prioridade, `once` e cancelar subscrições

```ts
import { defineEvent, EventBus } from '@machize/events'

const AppBooted = defineEvent('app.booted')
const bus = new EventBus()

bus.on(AppBooted, () => console.log('primeiro'), { priority: 10 }) // maior corre primeiro
bus.on(AppBooted, () => console.log('último'), { priority: -1 })
bus.once(AppBooted, () => console.log('só uma vez'))

const off = bus.on(AppBooted, () => console.log('nunca corre'))
off() // cancelar a subscrição

await bus.emit(AppBooted)
```

### Falhas nos ouvintes

Um ouvinte que lança um erro **não impede** os restantes: todos correm, e no fim o `emit` lança um `AggregateError` com todas as falhas (em `error.errors`). Assim, um ouvinte partido nunca "esconde" os outros.

### Outbox: entregar eventos ao exterior sem os perder

Usa o `Outbox` diretamente quando queres controlar o momento da entrega:

```ts
import { MemoryOutboxStore, Outbox } from '@machize/events'

const outbox = new Outbox(new MemoryOutboxStore(), { maxAttempts: 3 })

// 1. Gravar (idealmente na mesma transação da alteração de estado):
await outbox.enqueue('invoice.paid', { id: 'in_1' }, 'tenant-acme')

// 2. Entregar as entradas pendentes (o "carteiro"):
const result = await outbox.flush(async (entry) => {
  // envia para o exterior: webhook, Kafka, etc.
  console.log(`a entregar ${entry.event}`, entry.payload)
})
console.log(result) // { published: 1, failed: 0 }
```

Se o `dispatch` lançar, a entrada fica marcada como falhada (`attempts + 1`, `lastError`) e volta a ser tentada no próximo `flush` — até `maxAttempts` (default 10); depois disso fica "morta" e deixa de ser escolhida. As entregas seguem a ordem de criação (FIFO).

### `outboxPlugin`: captura automática + entrega periódica

O plugin liga tudo: captura eventos do bus para o outbox e entrega-os num temporizador.

```ts
import { createApp } from '@machize/core'
import { defineEvent, EVENTS, eventsPlugin, MemoryOutboxStore, outboxPlugin } from '@machize/events'

const app = await createApp({
  plugins: [
    eventsPlugin(),
    outboxPlugin({
      store: new MemoryOutboxStore(), // em produção: um store durável (base de dados)
      captureEvents: ['invoice.*'],   // padrões a gravar automaticamente no outbox
      intervalMs: 5000,               // entrega pendentes a cada 5 s
      dispatch: async (entry) => {
        // o teu envio real (ex.: webhook):
        await fetch('https://hooks.exemplo.com', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: entry.event, payload: entry.payload }),
        })
      },
    }),
  ],
}).boot()

const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
await app.container.get(EVENTS).emit(InvoicePaid, { amount: 5 })
// → gravado no outbox; entregue no próximo ciclo de 5 s

await app.shutdown() // pára o temporizador e faz um último flush (best-effort)
```

Detalhes úteis: com `captureEvents`, o plugin passa a depender de `machize:events` (adiciona o `eventsPlugin`!); se houver um contexto ativo com `tenant.id` (via `runWithContext` do core), o tenant é gravado em cada entrada; sem `intervalMs`, fazes o flush manualmente com `app.container.get(OUTBOX).flush(dispatch)`.

## Referência da API

### `defineEvent<T>(name, schema?)`

Cria um `MachizeEvent<T>`: `{ name, schema? }`. `T` default `void` (evento sem payload). `schema` é qualquer objeto com `safeParse` (`EventSchema<T>`, compatível com Zod).

### `EventBus`

| Método | Parâmetros | Devolve | Descrição |
|---|---|---|---|
| `on(event, handler, options?)` | `MachizeEvent<T>` ou `string` (padrão), `EventHandler<T>`, `ListenOptions?` | `() => void` | Subscreve; devolve função de cancelamento. |
| `once(event, handler)` | `MachizeEvent<T>`, `EventHandler<T>` | `() => void` | Atalho para `on(..., { once: true })`. |
| `emit(event, payload?)` | `MachizeEvent<T>`, payload se `T` não for `void` | `Promise<void>` | Valida (se houver schema), corre os ouvintes **em série** por prioridade; agrega falhas num `AggregateError`. |
| `listenerCount(eventName)` | `string` | `number` | Nº de registos cujo padrão corresponde ao nome. |

`EventHandler<T>` = `(payload: T, meta: EventMeta) => void | Promise<void>`; `EventMeta` = `{ name: string }`.

`ListenOptions`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `priority` | `number` | não | `0` | Maior corre primeiro. |
| `once` | `boolean` | não | `false` | Remove o ouvinte após a primeira execução. |

### `eventsPlugin()` / `EVENTS`

`eventsPlugin()` devolve o plugin `machize:events`, que regista um `EventBus` singleton no container sob o token `EVENTS` (`Token<EventBus>`).

### `EventValidationError`

Lançado pelo `emit` quando o payload falha o schema, **antes** de qualquer ouvinte correr. Estende `MachizeError` com `code: 'EVENT_INVALID'`; campos `event` (nome) e `issues` (detalhes da validação).

### `Outbox`

`new Outbox(store, options?)`:

| Opção (`OutboxOptions`) | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `maxAttempts` | `number` | não | `10` | Tentativas antes de a entrada ficar "morta" (excluída de flushes futuros). |
| `now` | `() => number` | não | `Date.now` | Relógio (útil em testes). |

| Método | Parâmetros | Devolve | Descrição |
|---|---|---|---|
| `enqueue(event, payload, tenantId?)` | `string`, `unknown`, `string?` | `Promise<OutboxEntry>` | Grava uma entrada com `createdAt = now()`. |
| `flush(dispatch, batchSize?)` | `OutboxDispatch`, `number` (default `50`) | `Promise<FlushResult>` | Entrega até `batchSize` pendentes (FIFO); marca sucesso/falha por entrada. |

`OutboxDispatch` = `(entry: OutboxEntry) => void | Promise<void>`; `FlushResult` = `{ published: number; failed: number }`.

`OutboxEntry`: `id`, `event`, `payload`, `tenantId?`, `createdAt`, `attempts`, `publishedAt?`, `lastError?`.

### `OutboxStore` / `MemoryOutboxStore`

Interface de persistência: `enqueue`, `pending(limit, maxAttempts)` (não publicadas, abaixo do limite de tentativas, mais antigas primeiro), `markPublished(id, at)`, `markFailed(id, error)`, `all()`. O `MemoryOutboxStore` implementa-a em memória (bom para dev/testes; **não sobrevive a reinícios** — em produção implementa `OutboxStore` sobre a tua base de dados).

### `outboxPlugin(options)` / `OUTBOX`

Devolve o plugin `machize:outbox`; regista o `Outbox` no token `OUTBOX` (`Token<Outbox>`).

| Opção (`OutboxPluginOptions`) | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `dispatch` | `OutboxDispatch` | **sim** | — | Entrega uma entrada ao exterior (webhooks, Kafka, …). |
| `store` | `OutboxStore` | não | `new MemoryOutboxStore()` | Armazém durável das entradas. |
| `captureEvents` | `string[]` | não | `[]` | Padrões de eventos a gravar automaticamente (exige `eventsPlugin`). |
| `intervalMs` | `number` | não | — | Intervalo de flush automático, em ms. Omite para flush manual via `OUTBOX`. |
| `batchSize` | `number` | não | `50` | Máximo de entradas por flush. |
| `maxAttempts` | `number` | não | `10` | Herdado de `OutboxOptions`. |
| `now` | `() => number` | não | `Date.now` | Herdado de `OutboxOptions`. |

No `shutdown`, o plugin pára o temporizador e faz um último `flush` (best-effort).

## Erros comuns e soluções (FAQ)

**"Invalid payload for event …" (`EVENT_INVALID`)** — O payload não corresponde ao schema do evento. Corrige o objeto passado ao `emit`; nenhum ouvinte correu, portanto não há efeitos parciais.

**O `emit` lançou `AggregateError`** — Um ou mais ouvintes falharam, mas todos correram. Inspeciona `error.errors` para veres cada falha individual. Decide se relanças ou apenas registas.

**Subscrevi `order.*` mas não apanho `order.payment.failed`** — `*` corresponde a exatamente um segmento. Usa `order.**` para qualquer profundidade.

**Plugin "machize:outbox" depends on "machize:events"** — Usaste `captureEvents` sem adicionar o `eventsPlugin()` à aplicação. Adiciona-o à lista de `plugins`.

**Os eventos capturados não aparecem logo no store** — A captura faz `void outbox.enqueue(...)` (assíncrona, sem espera). Em testes, dá uma volta ao event loop antes de verificar: `await new Promise((r) => setTimeout(r, 0))`.

**Perdi entradas do outbox depois de reiniciar** — Estás a usar o `MemoryOutboxStore`, que vive só em memória. Em produção implementa `OutboxStore` sobre uma base de dados e grava o `enqueue` na mesma transação da alteração de estado.

**Uma entrada deixou de ser entregue** — Atingiu `maxAttempts` e ficou "morta". Consulta `store.all()` e olha para `attempts` e `lastError` para diagnosticar; corrige a causa e reencaminha manualmente se necessário.

**O mesmo evento foi entregue duas vezes** — A entrega é *at-least-once* por definição (ex.: crash entre o `dispatch` e o `markPublished`). O recetor deve ser idempotente — usa o `entry.id` para eliminar duplicados.

## Como se liga aos outros módulos

- **`@machize/core`** — o `eventsPlugin` e o `outboxPlugin` são plugins do core; `EVENTS` e `OUTBOX` são tokens do container; `EventValidationError` estende `MachizeError`. O outbox lê o tenant do contexto do core (`tryCtx()?.tenant?.id`) quando grava eventos capturados. Nota a diferença para o `HookBus` do core: os hooks são infraestrutura interna do framework (ciclo de vida, extensões); o `EventBus` é para eventos **do teu domínio de negócio**, com validação e wildcards.
- **`@machize/config`** — sem ligação direta; usa-o para guardar definições do outbox (intervalos, URLs de destino) e lê-las ao construir o `outboxPlugin`.
- **`@machize/env`** — os schemas Zod que usas no `defineEnv` são o mesmo estilo dos que passas ao `defineEvent`; usa o `env` para as credenciais/URLs que o teu `dispatch` precisa.
