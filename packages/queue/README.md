# @machize/queue

Filas de trabalho (queues) para aplicações Machize: define "jobs" (tarefas) declarativos com validação Zod, executa-os em segundo plano com BullMQ/Redis em produção, e de forma síncrona em desenvolvimento e testes — sem mudares uma linha de código.

Precisas deste módulo quando tens trabalho que **não deve bloquear o pedido do utilizador**: enviar e-mails, gerar relatórios, processar imagens, sincronizar dados, etc.

---

## O que este módulo resolve

Uma **fila (queue)** é uma lista de espera de tarefas. Em vez de fazeres o trabalho pesado imediatamente (e obrigares o utilizador a esperar), colocas a tarefa na fila e respondes logo. Um **worker** (trabalhador) — um processo que pode estar noutra máquina — vai buscar as tarefas à fila e executa-as, uma a uma ou várias em paralelo. Cada tarefa individual chama-se um **job**.

Este módulo dá-te três coisas que normalmente terias de construir à mão:

1. **Jobs declarativos e seguros** — defines cada job uma vez com `defineJob` (nome, esquema de validação, número de tentativas) e depois chamas `MeuJob.dispatch(dados)` em qualquer ponto da aplicação. Os dados são validados com Zod *antes* de entrarem na fila, por isso dados inválidos nunca chegam ao worker.
2. **Propagação de contexto** — informação do pedido atual (`requestId`, `tenantId`, `userId`, etc.) viaja automaticamente junto com o job e é restaurada dentro do worker. Os teus logs e verificações de tenant funcionam no worker como funcionavam no pedido HTTP.
3. **Dois drivers intercambiáveis** — em produção usa o **BullMQ** (sobre Redis, com retries e atrasos reais); em desenvolvimento e testes usa o driver **sync**, que executa o job imediatamente, no mesmo processo, sem precisares de Redis instalado.

## Instalação

```bash
pnpm add @machize/queue
```

O pacote depende de `@machize/core` e `@machize/events` (instalados automaticamente). Para produção precisas também de um servidor **Redis** acessível (o BullMQ guarda lá as filas). Para desenvolvimento e testes não precisas de nada.

## Começar em 5 minutos

Passo a passo para teres um job a funcionar:

**1. Define o job** (num ficheiro próprio, ex.: `src/jobs/send-welcome-email.ts`):

```ts
import { defineJob } from '@machize/queue'
import { z } from 'zod'

export const SendWelcomeEmail = defineJob({
  name: 'email.welcome',                       // nome único do job
  schema: z.object({ userId: z.string() }),    // formato dos dados (validado)
  attempts: 3,                                 // tenta até 3 vezes se falhar
  backoff: { type: 'exponential', delay: '30s' }, // espera crescente entre tentativas
  async handle({ userId }) {
    // o trabalho em si — corre no worker
    console.log(`A enviar e-mail de boas-vindas ao utilizador ${userId}`)
  },
})
```

**2. Regista o plugin na aplicação** (ex.: `src/app.ts`):

```ts
import { createApp } from '@machize/core'
import { queuePlugin } from '@machize/queue'
import { SendWelcomeEmail } from './jobs/send-welcome-email.js'

const app = await createApp({
  plugins: [
    queuePlugin({
      jobs: [SendWelcomeEmail],
      // sem `connection` → driver sync: executa logo, sem Redis (ideal em dev)
    }),
  ],
}).boot()
```

**3. Despacha o job onde precisares:**

```ts
await SendWelcomeEmail.dispatch({ userId: 'u-123' })
```

Pronto. Em dev o `handle` corre imediatamente. Quando quiseres o comportamento real de produção, acrescenta a ligação ao Redis e os workers:

```ts
queuePlugin({
  jobs: [SendWelcomeEmail],
  connection: 'redis://localhost:6379',        // ativa o driver BullMQ
  workers: [{ queue: 'default', concurrency: 5 }], // este processo processa a fila
})
```

## Guia de utilização

### Definir um job com `defineJob`

```ts
import { defineJob } from '@machize/queue'
import { z } from 'zod'

export const GenerateInvoice = defineJob({
  name: 'billing.invoice',
  schema: z.object({ orderId: z.string() }),
  queue: 'billing',      // fila dedicada (por omissão: 'default')
  attempts: 5,
  backoff: { type: 'fixed', delay: '1m' },
  async handle({ orderId }) {
    // gerar a fatura…
  },
})
```

O `schema` é opcional mas recomendado: valida os dados **duas vezes** — no `dispatch` (antes de entrar na fila) e no worker (antes de executar). Um payload inválido lança `JobValidationError` logo no `dispatch`, sem sujar a fila.

### Despachar com atraso ou prioridade

```ts
import { GenerateInvoice } from './jobs/generate-invoice.js'

// executa daqui a 10 minutos
await GenerateInvoice.dispatch({ orderId: 'o-1' }, { delay: '10m' })

// prioridade (número menor = mais prioritário, semântica BullMQ)
await GenerateInvoice.dispatch({ orderId: 'o-2' }, { priority: 1 })
```

Nota: com o driver sync o `delay` é ignorado — o job executa imediatamente.

### Propagação de contexto (tenant, requestId…)

Se despachares um job dentro de um pedido com contexto ativo (`runWithContext` do `@machize/core`, normalmente feito pelo middleware HTTP), os campos `requestId`, `correlationId`, `traceId`, `userId`, `tenantId` — e `tenant.id` / `user.id` — são fotografados e restaurados dentro do `handle`:

```ts
import { ctx, runWithContext } from '@machize/core'
import { defineJob, QueueManager, SyncQueueDriver } from '@machize/queue'

const job = defineJob({
  name: 'ctx.probe',
  handle: () => {
    // dentro do worker, o contexto original está disponível
    console.log(ctx().requestId, ctx()['tenant'])
  },
})

const manager = new QueueManager(new SyncQueueDriver())
manager.register(job)

await runWithContext({ requestId: 'req-7', tenant: { id: 'acme', name: 'Acme' } }, () =>
  job.dispatch({}),
)
// no handle: requestId = 'req-7', tenant = { id: 'acme' }  (só o id é serializado)
```

### Transformar um listener de eventos num job: `queuedOn`

Se usas `@machize/events`, o `queuedOn` faz a ponte eventos→fila: o `emit` apenas coloca o job na fila, e o handler corre no worker com retries e contexto restaurado.

```ts
import { EventBus, defineEvent } from '@machize/events'
import { QueueManager, SyncQueueDriver, queuedOn } from '@machize/queue'
import { z } from 'zod'

const bus = new EventBus()
const manager = new QueueManager(new SyncQueueDriver())
const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

const unsubscribe = queuedOn(bus, manager, OrderCreated, async ({ orderId }) => {
  // corre no worker, com retry/backoff do driver
}, { queue: 'orders', attempts: 3 })

await bus.emit(OrderCreated, { orderId: 'o-1' })
// o job criado chama-se 'listener:order.created'
```

`queuedOn` devolve a função para cancelar a subscrição.

### Produtor e worker em processos separados (produção)

Um processo pode só **produzir** (fazer `dispatch`) e outro só **consumir** (correr workers). Ambos têm de registar os **mesmos jobs** (o worker precisa do `handle`):

```ts
// processo API (só produz)
queuePlugin({ jobs: [SendWelcomeEmail, GenerateInvoice], connection: process.env.REDIS_URL! })

// processo worker (consome)
queuePlugin({
  jobs: [SendWelcomeEmail, GenerateInvoice],
  connection: process.env.REDIS_URL!,
  workers: [
    { queue: 'default', concurrency: 5 },
    { queue: 'billing', concurrency: 2 },
  ],
})
```

Se um job chegar a um worker que não o registou, é lançado `UnknownJobError`.

### Uso manual sem plugin (ex.: em testes)

```ts
import { QueueManager, SyncQueueDriver, defineJob } from '@machize/queue'

const driver = new SyncQueueDriver()
const manager = new QueueManager(driver)

const job = defineJob({ name: 'demo', handle: () => {} })
manager.register(job)

await job.dispatch({})
console.log(driver.executed) // [{ queue: 'default', jobName: 'demo', attempts: 1 }]
```

O `SyncQueueDriver` guarda o histórico em `driver.executed` — muito útil em asserções de teste.

## Referência da API

### `defineJob<T>(config): JobDefinition<T>`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `name` | `string` | Sim | — | Nome único do job (ex.: `'email.welcome'`). |
| `schema` | `JobSchema<T>` (compatível com Zod) | Não | — | Valida o payload no dispatch e no worker. |
| `queue` | `string` | Não | `'default'` | Nome da fila onde o job entra. |
| `attempts` | `number` | Não | `1` | Número máximo de tentativas em caso de falha. |
| `backoff` | `JobBackoff` | Não | — | Estratégia de espera entre tentativas. |
| `handle` | `(payload: T) => void \| Promise<void>` | Sim | — | A função que faz o trabalho (corre no worker). |

O objeto devolvido (`JobDefinition<T>`) expõe:

- `dispatch(payload, options?)` — coloca o job na fila. Lança `JobNotRegisteredError` se o job ainda não foi registado num `QueueManager`.
- `name`, `schema`, `queue`, `attempts`, `backoff`, `handle` — os valores configurados.
- `__bind(dispatcher)` — **Avançado/interno**: usado pelo `QueueManager` ao registar.

### `DispatchOptions`

| Campo | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `delay` | `DurationInput` (ex.: `'30s'`, `'10m'`, ou ms) | Não | sem atraso | Atrasa a execução (apenas driver BullMQ). |
| `priority` | `number` | Não | — | Prioridade BullMQ (menor = mais prioritário). |

### `JobBackoff`

| Campo | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `type` | `'exponential' \| 'fixed'` | Sim | — | Espera crescente ou constante entre tentativas. |
| `delay` | `DurationInput` | Sim | — | Espera base (ex.: `'30s'`). |

### `queuePlugin(options?: QueuePluginOptions)`

Plugin Machize que regista um `QueueManager` no contentor sob o token `QUEUE`, arranca workers no `boot` e fecha tudo no `shutdown`.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `jobs` | `JobDefinition[]` | Não | `[]` | Jobs conhecidos por este processo (produtor e/ou worker). |
| `connection` | `string \| ConnectionOptions` | Não | — | URL Redis (`redis://…` ou `rediss://…`) ou opções ioredis. Com valor → driver BullMQ; sem valor → driver sync. |
| `driver` | `QueueDriver` | Não | — | Driver personalizado — tem precedência sobre `connection`. |
| `workers` | `{ queue: string; concurrency?: number }[]` | Não | `[]` | Filas cujos workers arrancam neste processo no boot. |

```ts
import { QUEUE } from '@machize/queue'
const manager = app.container.get(QUEUE) // obter o QueueManager do contentor
```

### `class QueueManager` — implementa `JobDispatcher`

| Método | Assinatura | Descrição |
|---|---|---|
| `constructor` | `new QueueManager(driver: QueueDriver)` | Cria o gestor sobre um driver. |
| `register` | `(job) => this` | Regista um job e liga-lhe o `dispatch`. |
| `dispatch` | `<T>(job, payload: T, options?: DispatchOptions) => Promise<void>` | Valida e coloca o job na fila. Auto-regista o job se ainda não estiver. |
| `work` | `(queue = 'default', { concurrency? }?) => void` | Arranca um worker para a fila (no-op no driver sync). |
| `close` | `() => Promise<void>` | Fecha workers e ligações. |

### `queuedOn<T>(bus, manager, event, handler, options?): () => void`

Cria a ponte evento→job. Devolve a função de cancelamento da subscrição.

`QueuedListenerOptions`:

| Campo | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `queue` | `string` | Não | `'default'` | Fila do job criado. |
| `attempts` | `number` | Não | `1` | Tentativas do job. |
| `backoff` | `JobBackoff` | Não | — | Backoff do job. |

### Drivers

- **`class SyncQueueDriver`** — executa inline no `dispatch`, honra `attempts` (retry imediato). Propriedade pública `executed: { queue, jobName, attempts }[]` com o histórico de execuções. Para testes e dev sem Redis.
- **`class BullmqQueueDriver`** — produção sobre Redis. `new BullmqQueueDriver({ connection })`, onde `connection` é URL Redis ou opções ioredis (`BullmqDriverOptions`). Jobs completos são limpos (mantém 1000); jobs falhados ficam guardados.
- **`interface QueueDriver`** (Avançado) — contrato para drivers personalizados: `setExecutor(executor)`, `add(queue, jobName, data, options: AddJobOptions)`, `startWorker(queue, { concurrency? })`, `close()`. Tipos auxiliares: `AddJobOptions`, `JobExecutor`.

### Erros exportados

| Classe | Código | Quando ocorre |
|---|---|---|
| `JobValidationError` | `JOB_INVALID` | Payload não passa no `schema` (tem `.job` e `.issues`). |
| `JobNotRegisteredError` | `QUEUE_JOB_NOT_REGISTERED` | `dispatch` antes de registar o job num manager. |
| `UnknownJobError` | `QUEUE_UNKNOWN_JOB` | O job chegou ao worker mas não está registado nesse processo. |

### Token

- `QUEUE: Token<QueueManager>` — token de injeção para obter o manager do contentor.

## Erros comuns e soluções (FAQ)

**"Job X has not been registered in a QueueManager yet" ao fazer `dispatch`.**
O job não foi passado em `queuePlugin({ jobs: [...] })` nem registado com `manager.register(job)`. Acrescenta-o à lista de jobs do plugin.

**"Job X reached the worker but is not registered in this process".**
O processo worker não conhece esse job. Produtor e worker têm de registar a **mesma** lista de jobs.

**O job nunca executa em produção.**
Verifica se algum processo arrancou workers para a fila certa: `queuePlugin({ workers: [{ queue: 'default' }] })` ou `manager.work('default')`. Verifica também que a fila (`queue`) do job coincide com a do worker.

**`JobValidationError: Invalid payload…`**
Os dados passados ao `dispatch` não respeitam o `schema`. O erro inclui `issues` com o detalhe do Zod. Isto é intencional — protege a fila de dados corrompidos.

**Em dev, o `delay` não funciona.**
O driver sync executa sempre imediatamente. Atrasos, backoff temporizado e prioridade só têm efeito real com o driver BullMQ (com `connection`).

**Preciso de Redis para correr os testes?**
Não. Sem `connection`, o plugin usa o `SyncQueueDriver`. Podes também instanciar o driver diretamente e inspecionar `driver.executed`.

## Como se liga aos outros módulos

- **`@machize/core`** — fornece `createApp`/`definePlugin` (o `queuePlugin` é um plugin core), o contexto ALS (`runWithContext`/`ctx`) que é propagado para os workers, `parseDuration` (formatos `'30s'`, `'10m'`) e a classe base `MachizeError`.
- **`@machize/events`** — via `queuedOn`, qualquer evento de domínio pode passar a ser processado em segundo plano com retries.
- **`@machize/scheduler`** — `schedule.job(MeuJob, payload)` agenda o `dispatch` de um job desta fila em horários cron (ex.: reconciliação diária às 03:00).
- **`@machize/logger`** — como o contexto é restaurado no worker, os logs escritos dentro de `handle` saem automaticamente com `requestId`/`tenantId` do pedido original.
- **`@machize/audit`** e **`@machize/activity`** — registos feitos dentro de um `handle` herdam o mesmo contexto (ator, tenant), mantendo o rasto coerente entre pedido e worker.
