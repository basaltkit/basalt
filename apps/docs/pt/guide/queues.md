# Queues e jobs

`@basaltkit/queue` executa trabalho em segundo plano através de um núcleo pequeno e
agnóstico ao driver. Defines jobs tipados, despachas a partir de qualquer sítio, e
os workers processam-nos — em Redis (BullMQ) em produção, inline em dev/testes, ou
em RabbitMQ, Kafka ou Amazon SQS através de um pacote de driver. O backend troca-se
numa linha; os teus jobs nunca mudam.

[[toc]]

## Definir um job

```ts
import { defineJob } from '@basaltkit/queue'
import { z } from 'zod'

export const SendWelcome = defineJob({
  name: 'send-welcome',
  queue: 'welcome',                 // qual a queue/worker que o trata (predefinição 'default')
  schema: z.object({ userId: z.string() }),
  attempts: 3,                      // tenta novamente até 3 vezes
  backoff: { type: 'exponential', delay: '30s' },
  async handle({ userId }) {
    // ... faz o trabalho
  },
})
```

O `schema` torna o payload type-safe de ponta a ponta — o argumento de `handle` e o
payload de `dispatch` são ambos inferidos a partir dele, e o payload é validado no
dispatch.

## Registá-lo

`queuePlugin` regista um `QueueManager` sob o token `QUEUE`, arranca os workers
declarados no `boot`, e fecha tudo no `shutdown`:

```ts
import { createApp } from '@basaltkit/core'
import { queuePlugin } from '@basaltkit/queue'
import { SendWelcome } from './jobs/send-welcome.js'

const app = await createApp({
  plugins: [
    queuePlugin({
      connection: process.env.REDIS_URL,     // → driver BullMQ. Omite para o driver sync.
      jobs: [SendWelcome],                    // jobs que este processo produz e/ou executa
      workers: [{ queue: 'welcome', concurrency: 5 }], // arranca um worker para esta queue
    }),
  ],
}).boot()
```

Sem `connection` (e sem `driver`), o plugin usa o driver **sync**: `dispatch` executa
`handle` inline no mesmo processo — sem Redis, ideal para dev e testes. A `queue` de
um worker **tem de corresponder** à `queue` de um job, ou o job vai parar ao backend
mas ninguém o consome.

### Producer e worker em processos separados

Em produção, o processo da API normalmente só **produz** (chama `dispatch`), enquanto
um processo separado **consome**. Ambos têm de registar os **mesmos jobs** — o worker
precisa do `handle` de cada job, e um job que chega a um worker que não o registou
lança `UnknownJobError`. Só o consumidor declara `workers`:

```ts
// processo da API — só produz (sem `workers`)
queuePlugin({ jobs: [SendWelcome, GenerateInvoice], connection: process.env.REDIS_URL })

// processo worker — consome
queuePlugin({
  jobs: [SendWelcome, GenerateInvoice],
  connection: process.env.REDIS_URL,
  workers: [
    { queue: 'welcome', concurrency: 5 },
    { queue: 'billing', concurrency: 2 },
  ],
})
```

## Dispatch

```ts
import { ctx } from '@basaltkit/core'
import { QUEUE } from '@basaltkit/queue'

await ctx().container.get(QUEUE).dispatch(SendWelcome, { userId: 'u-1' })

// ou diretamente a partir do job (assim que estiver registado):
await SendWelcome.dispatch({ userId: 'u-1' }, { delay: '5m', priority: 5 })
```

`dispatch` retorna assim que o job é enfileirado. O contexto do pedido
(`requestId`, `tenantId`, …) é capturado e restaurado dentro do worker.

## Drivers

O backend é escolhido pelo driver. `connection` opta por BullMQ; passa um `driver`
para usar outro backend.

| Driver | Pacote | `delayed` | `priority` | `retries` | `backoff` |
| --- | --- | :---: | :---: | :---: | :---: |
| **BullMQ** (Redis) | `@basaltkit/queue` | ✅ | ✅ | ✅ | ✅ |
| **RabbitMQ** | `@basaltkit/queue-rabbitmq` | ✅ | ✅ | ✅ | ✅ |
| **Amazon SQS** | `@basaltkit/queue-sqs` | ✅ (≤15 min) | ❌ | ✅ | ✅ |
| **Kafka** | `@basaltkit/queue-kafka` | ❌ | ❌ | ✅ | ❌ |
| **Sync** (dev/testes) | `@basaltkit/queue` | ❌ | ❌ | ✅ | ❌ |

```ts
import { RabbitmqQueueDriver } from '@basaltkit/queue-rabbitmq'
queuePlugin({ driver: new RabbitmqQueueDriver({ url: process.env.AMQP_URL! }), jobs, workers })

import { SqsQueueDriver } from '@basaltkit/queue-sqs'
queuePlugin({ driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => QUEUE_URLS[q] }), jobs, workers })

import { KafkaQueueDriver } from '@basaltkit/queue-kafka'
queuePlugin({ driver: new KafkaQueueDriver({ brokers: ['localhost:9092'] }), jobs, workers })
```

## Verificações de capacidade

Os backends diferem — o Kafka não tem prioridade de mensagem, o SQS limita os atrasos
a 15 minutos, o driver sync corre inline. Em vez de descartar silenciosamente uma
opção que o backend não consegue honrar, cada driver declara as suas `capabilities`
e a queue verifica cada dispatch contra elas.

```ts
queuePlugin({
  driver: new KafkaQueueDriver({ brokers }),
  onUnsupported: 'throw', // 'warn' (predefinição) · 'throw' · 'ignore'
})

// um job com atraso em Kafka:
await Job.dispatch(payload, { delay: '5m' })
//  onUnsupported: 'warn'  → regista uma vez, executa imediatamente
//  onUnsupported: 'throw' → lança UnsupportedJobOptionError
//  onUnsupported: 'ignore'→ prossegue silenciosamente (legacy)
```

Usa `'throw'` em produção para uma garantia rígida; a predefinição `'warn'` nunca
quebra uma execução de dev mas também nunca esconde uma opção descartada.

## Executar domain events na queue

`queuedOn` faz a ponte `@basaltkit/events` → queue: `emit` apenas enfileira um job, e
o handler corre no worker com retries e contexto restaurado. Retorna a função de
unsubscribe; o job criado tem o nome `listener:<event>`.

```ts
import { EventBus, defineEvent } from '@basaltkit/events'
import { QUEUE, queuedOn } from '@basaltkit/queue'
import { ctx } from '@basaltkit/core'
import { z } from 'zod'

const bus = new EventBus()
const manager = ctx().container.get(QUEUE)
const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

const unsubscribe = queuedOn(bus, manager, OrderCreated, async ({ orderId }) => {
  // corre no worker, com o retry/backoff do driver
}, { queue: 'orders', attempts: 3 })

await bus.emit(OrderCreated, { orderId: 'o-1' })
```

## Erros

| Classe | Código | Quando |
| --- | --- | --- |
| `JobValidationError` | `JOB_INVALID` | O payload falha o `schema` do job (lançado no `dispatch`; tem `.job` e `.issues`) |
| `JobNotRegisteredError` | `QUEUE_JOB_NOT_REGISTERED` | `dispatch` antes de o job ter sido registado num manager (adiciona-o a `jobs`) |
| `UnknownJobError` | `QUEUE_UNKNOWN_JOB` | Um job chegou a um worker que não o registou (as listas de jobs do producer/worker diferem) |
| `UnsupportedJobOptionError` | — | Um dispatch pediu uma opção que o driver não consegue honrar, com `onUnsupported: 'throw'` |

## Escrever um driver

Um driver é qualquer objeto que implemente a interface `QueueDriver` — quatro métodos
e uma declaração de capacidade opcional:

```ts
import type { QueueDriver, DriverCapabilities, JobExecutor, AddJobOptions } from '@basaltkit/queue'

export class MyQueueDriver implements QueueDriver {
  readonly name = 'my-backend'
  // Declara o que o backend honra. Omite-o e o driver assume-se totalmente
  // capaz (retrocompatibilidade) — mas então nada é verificado, por isso prefere declará-lo.
  readonly capabilities: DriverCapabilities = { delayed: false, priority: false, retries: true, backoff: false }

  private executor: JobExecutor | undefined

  // O QueueManager chama isto uma vez, entregando-te como executar um job recebido.
  setExecutor(executor: JobExecutor): void {
    this.executor = executor
  }

  // Enfileira. `options` transporta attempts/backoff/delayMs/priority — honra o que
  // as tuas `capabilities` afirmam; o QueueManager já aplicou a sua política
  // onUnsupported ao resto.
  async add(queue: string, jobName: string, data: unknown, options: AddJobOptions): Promise<void> {
    // publica { jobName, data, options } no teu backend
  }

  // Começa a consumir `queue`. Para cada job recebido chama
  // `this.executor(jobName, data)`; em sucesso remove-o, em falha faz retry ou
  // dead-letter conforme o modelo do teu backend.
  startWorker(queue: string, options?: { concurrency?: number }): void {
    // consome → await this.executor?.(jobName, data)
  }

  async close(): Promise<void> {
    // desliga producers/consumers
  }
}
```

Depois liga-o:

```ts
queuePlugin({ driver: new MyQueueDriver(), jobs, workers })
```

**Orientações para um driver fiel:**

- **Sê honesto nas `capabilities`.** Se o backend não consegue adiar uma mensagem,
  define `delayed: false` — a verificação de compatibilidade transforma um descarte
  silencioso num ruidoso. Os drivers incluídos são uma referência:
  [`@basaltkit/queue-rabbitmq`][rmq] (delay + retries via dead-letter queue),
  [`@basaltkit/queue-sqs`][sqs] (delay nativo, sem priority),
  [`@basaltkit/queue-kafka`][kafka] (um log, por isso sem delay/priority; retries via
  retry topic).
- **Transporta o estado de retry na mensagem.** `attempts`/`backoff` vêm do `add`;
  carimba a tentativa atual nos metadados da mensagem para que o worker saiba quando
  fazer retry versus dead-letter.
- **Torna o cliente injetável.** Cada driver incluído recebe um conector injetável
  (`connect`/`client`/`api`), pelo que a sua lógica de retry e dead-letter é testada
  unitariamente sem um broker em execução. Faz o mesmo e o teu driver fica testável
  em CI.

[rmq]: https://github.com/Zebedeu/basalt/tree/main/packages/queue-rabbitmq
[sqs]: https://github.com/Zebedeu/basalt/tree/main/packages/queue-sqs
[kafka]: https://github.com/Zebedeu/basalt/tree/main/packages/queue-kafka

## Ver também

- [Cookbook Notes SaaS](/pt/cookbook/notes-saas) — queues ligadas a uma app real
  (BullMQ + Redis, mailer fora do request).
