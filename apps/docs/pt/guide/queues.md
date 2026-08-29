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
`handle` inline no mesmo processo — sem Redis, ideal para dev e testes. Conhece a
semântica antes de dependeres dele: é **at-most-once** (um job que esgota os
retries inline perde-se), erros do handler **rejeitam a chamada `dispatch()`**
(o teu request falha em vez de haver retry em background), e não se destina a
produção — um deploy de produção que caia nele sem `connection` Redis regista um
aviso no boot (passa `driver: new SyncQueueDriver()` para optar deliberadamente). A `queue` de
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

Todos os drivers incluídos seguem a mesma norma de observabilidade: **falhas de
infraestrutura — broker em baixo, o connect de um worker a falhar no boot, uma
re-publicação de retry a falhar — surgem através de uma opção da família
`onError`, com um default `console.error` contextual (prefixo
`[basalt:queue]`)**. Nunca são rejeições não tratadas que matam o processo, e
nunca são silenciosas.

### BullMQ (Redis)

`connection` no `queuePlugin` é um atalho para este driver. Ambos os canais de
falha são configuráveis **ali mesmo** — não precisas de construir o driver à mão
para teres observabilidade:

```ts
queuePlugin({
  connection: process.env.REDIS_URL!,
  jobs,
  workers,
  onError: (error, { queue, source }) => log.error({ queue, source, error }, 'queue infra error'),
  onJobFailed: ({ queue, job, jobId, error }) => alertDeadJob(queue, job, jobId, error),
})
```

O `onError`/`onJobFailed` no `queuePlugin` são encaminhados para o driver
construído a partir de `connection`. São **ignorados quando passas o teu próprio
`driver`** — configura-os no driver, que é também como chegas a qualquer opção
que o atalho não exponha:

```ts
import { BullmqQueueDriver } from '@basaltkit/queue'

queuePlugin({
  driver: new BullmqQueueDriver({
    connection: process.env.REDIS_URL!,
    onError: (error, { queue, source }) => log.error({ queue, source, error }, 'queue infra error'),
  }),
  jobs,
  workers,
})
```

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `connection` | `string \| ConnectionOptions` | — (obrigatória) | URL Redis (`redis://`/`rediss://`, TLS inferido) ou opções ioredis. |
| `onError` | `(error, { queue, source: 'worker' \| 'queue' }) => void` | `console.error` com contexto | O BullMQ emite erros de infraestrutura (Redis em baixo) como eventos `'error'` de EventEmitter — sem handler, **derrubam o processo**. O driver anexa sempre um listener; esta opção encaminha-o para o teu logger/alerting. |
| `onJobFailed` | `({ queue, job, jobId?, error }) => void` | `console.error` com contexto | Dispara quando um job esgota os retries (`'failed'` do BullMQ). Sem isto, jobs falhados permanentemente só eram visíveis a consultar `queue:stats`. |

### RabbitMQ

```ts
import { RabbitmqQueueDriver } from '@basaltkit/queue-rabbitmq'

queuePlugin({ driver: new RabbitmqQueueDriver({ url: process.env.AMQP_URL! }), jobs, workers })
```

Retries e backoff usam uma delay queue por fila (`<queue>.delay`) cujas
mensagens expiram por TTL de volta para a fila principal; jobs esgotados vão
parar a `<queue>.dead`. A prioridade usa `x-max-priority`. Segurança de entrega:
o driver prefere um **canal com publisher confirms** e só faz ack de uma
mensagem depois de o broker confirmar qualquer re-publicação de
retry/dead-letter — fazer ack antes de a publicação estar confirmada seria uma
janela silenciosa de perda de jobs. `close()` drena primeiro os handlers em
curso; o que não terminar fica sem ack, e o broker reentrega-o.

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `url` | `string` | — (obrigatória) | URL AMQP, p. ex. `amqp://user:pass@host:5672`. |
| `onError` | `(error, { source: 'connection' \| 'channel' }) => void` | `console.error` com contexto | O amqplib expõe falhas do broker como eventos `'error'` de EventEmitter — sem handler, **derrubam o processo**. Recebe também a falha de connect/consume de um worker no boot (senão a app reportar-se-ia saudável com zero workers) e uma re-publicação/ack falhada após a falha de um job (a cópia durável fica no broker e é reentregue). |
| `maxPriority` | `number` | `10` | `x-max-priority` das filas com prioridade. |
| `drainTimeoutMs` | `number` | `10_000` | Quanto tempo `close()` espera pelos handlers em curso, para que os acks caiam num canal vivo. Passado o limite, jobs por terminar ficam sem ack e são reentregues — shutdown limitado no tempo, sem perda de jobs. |
| `connect` | `AmqpConnect` | amqplib | Conector injetável — os testes correm sem broker. |

::: tip Delays mistos em escala
A delay queue assenta em TTL por mensagem, que só liberta uma mensagem quando
ela chega à cabeça da fila (head-of-line blocking). Para muitos delays
diferentes na mesma fila, prefere o plugin delayed-message-exchange do RabbitMQ.
:::

### Amazon SQS

```ts
import { SqsQueueDriver } from '@basaltkit/queue-sqs'

queuePlugin({ driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => QUEUE_URLS[q] }), jobs, workers })
```

O SQS tem delay nativo por mensagem (≤ 15 minutos) mas não tem prioridade.
Retries e backoff são tratados ao nível da app, por paridade com os outros
drivers: uma mensagem falhada é reenviada com a tentativa incrementada e um
backoff em `DelaySeconds` (limitado a 15 min); um job esgotado vai para a
dead-letter queue (`<queue><deadSuffix>`). O resolvedor `queueUrl` tem de mapear
todos os nomes de fila — **incluindo os nomes das DLQ** — para o seu URL SQS.

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `queueUrl` | `(queue: string) => string` | — (obrigatória) | Resolve nomes de fila (e `<queue>-dead`) para URLs SQS. |
| `region` | `string` | default do SDK | Região AWS do cliente por defeito. |
| `deadSuffix` | `string` | `'-dead'` | Sufixo do nome da dead-letter queue. |
| `waitTimeSeconds` | `number` | `20` | Long-poll por receive. |
| `visibilityTimeout` | `number` | `30` | Quanto tempo uma mensagem recebida fica oculta enquanto é processada. |
| `onError` | `(error, { queue }) => void` | `console.error` com contexto | Uma chamada de receive falhou (rede, credenciais, fila apagada). Sem isto o poller re-tentava imediata e silenciosamente — um hot spin sem uma linha de log perante uma falha persistente. |
| `errorPauseMs` | `number` | `1000` | Pausa entre receives falhados consecutivos — limita o ritmo de retry contra um endpoint avariado. |
| `api` | `SqsApi` | AWS SDK | API injetável — os testes correm sem AWS. |

Um `delay` pedido pelo utilizador acima de 15 minutos lança
`SqsDelayTooLongError` no dispatch (um delay de *backoff* é limitado em vez
disso, para que os retries nunca lancem).

### Kafka

```ts
import { KafkaQueueDriver } from '@basaltkit/queue-kafka'

queuePlugin({ driver: new KafkaQueueDriver({ brokers: ['localhost:9092'] }), jobs, workers })
```

O Kafka é um log, não uma task queue, e o driver é deliberadamente honesto
quanto a isso: sem `delayed`, sem `priority`, sem `backoff` (o Kafka não
consegue adiar uma mensagem). Os retries publicam num retry topic
(`<queue>.retry`) que o worker também consome; jobs esgotados vão para
`<queue>.dead`. A `concurrency` do worker mapeia para
`partitionsConsumedConcurrently`, pelo que o paralelismo efetivo é limitado pelo
número de partições do tópico.

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `brokers` | `string[]` | — (obrigatória) | Brokers de bootstrap do Kafka. |
| `clientId` | `string` | `'basalt'` | Client id do kafkajs. |
| `groupId` | `string` | `'basalt-queue'` | Consumer group a que os workers se juntam. |
| `retrySuffix` | `string` | `'.retry'` | Sufixo do retry topic. |
| `deadSuffix` | `string` | `'.dead'` | Sufixo do tópico de dead-letter. |
| `onError` | `(error, { source: 'consumer' \| 'producer', queue? }) => void` | `console.error` com contexto | `source: 'consumer'`: o connect/subscribe/run do worker falhou no boot — sem isto a app reporta-se saudável com **zero workers** e a rejeição solta é fatal para o processo. `source: 'producer'`: uma re-publicação de retry/dead-letter falhou dentro do callback de consumo (vê abaixo). |
| `client` | `KafkaClient` | kafkajs | Cliente injetável — os testes correm sem broker. |

Quando a re-publicação de um job falhado para o tópico de retry/dead falha ela
própria (indisponibilidade do producer ou do broker), o driver reporta-a via
`onError` e depois **relança para que o offset da mensagem não seja
committed** — o Kafka reentrega a mensagem (at-least-once) em vez de o job
desaparecer silenciosamente. Conta com reentregas durante uma indisponibilidade
do producer, nunca com perda. (O RabbitMQ mantém a mensagem sem ack pela mesma
razão; não fazer commit do offset é o equivalente no Kafka.)

### Sync (dev/testes)

A semântica do driver inline está coberta [acima](#regista-lo): at-most-once,
erros do handler rejeitam `dispatch()`, e o fallback implícito em produção avisa
no boot. Para asserções em testes, regista cada execução em `driver.executed`
(`{ queue, jobName, attempts }`), limitado às **1000** entradas mais recentes
(as mais antigas são removidas) para que um processo de longa duração neste
driver não possa vazar memória.

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

## Retenção de jobs no Redis

Com o driver BullMQ, os jobs terminados ficam no Redis para os poderes
inspecionar e re-tentar. Por predefinição os **concluídos** mantêm os últimos
**1000**, e os **falhados** ficam **para sempre** — ou seja, o conjunto de
falhados pode crescer sem limite. Controla isso com `removeOnComplete` /
`removeOnFail`, globalmente no `queuePlugin` ou por job:

```ts
// Predefinição global para todos os jobs
queuePlugin({
  connection: process.env.REDIS_URL,
  jobs: [SendWelcome],
  removeOnComplete: { age: '7d' },   // mantém concluídos 7 dias
  removeOnFail: { age: '14d' },      // falhados deixam de crescer para sempre
})

// Por job — sobrepõe a predefinição global
defineJob({
  name: 'email.welcome',
  removeOnComplete: true,             // remove assim que termina
  removeOnFail: { count: 500 },       // mantém as últimas 500 falhas
  handle: () => {},
})
```

Cada opção aceita `true` (remove ao terminar), `false` (mantém tudo), um número
(mantém os N mais recentes), ou `{ age, count }` onde `age` é uma duração como
`'14d'`. Sem configuração, aplicam-se as predefinições acima. O driver **sync**
ignora a retenção — não guarda nada. (As chaves de estrutura da própria fila,
`bull:<queue>:*`, existem sempre depois de a fila ser criada; isso é do BullMQ,
não são jobs esquecidos.)

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
| `SqsDelayTooLongError` | — | Um `delay` acima do máximo de 15 minutos do SQS (`@basaltkit/queue-sqs`, lançado no `dispatch`) |

## Modos de falha e resolução de problemas

| Se vires | Significa | Faz |
| --- | --- | --- |
| Aviso no boot `[basalt:queue] No 'connection' (Redis) configured…` em produção | O plugin caiu silenciosamente no driver sync inline: at-most-once, sem retries em background, erros do handler falham o request que despachou | Configura uma `connection` Redis, ou passa `driver: new SyncQueueDriver()` para optar deliberadamente |
| `dispatch()` rejeita com o erro do teu handler | Semântica do driver sync: os erros propagam-se ao despachante por design (um driver com broker retornaria de imediato e re-tentaria em background) | Esperado em dev/testes; usa um driver com broker onde precisares de retries em background |
| Um job é enfileirado mas nunca corre | Nenhum worker declarado para a `queue` do job, ou o nome da `queue` do worker não corresponde ao do job | Alinha `defineJob({ queue })` com `workers: [{ queue }]` |
| `UnknownJobError` nos logs do worker | O job chegou a um worker que não o registou — as listas `jobs` do producer e do worker diferem | Regista o mesmo array `jobs` nos dois processos |
| `[basalt:queue] bullmq worker error (queue "…")` repetido | Falha de infraestrutura do Redis (conectividade, failover); o BullMQ religa-se sozinho | Encaminha `onError` para alerting; verifica o Redis |
| `[basalt:queue] job "…" on queue "…" failed permanently` | O job esgotou os `attempts`; fica no conjunto de falhados (a retenção por defeito mantém todos) | Inspeciona, corrige a causa, `basalt queue:retry --queue <q>`; encaminha `onJobFailed` para alerting |
| `UnsupportedJobOptionError` no dispatch | O driver não consegue honrar uma opção pedida (p. ex. `delay` em Kafka) com `onUnsupported: 'throw'` | Remove a opção ou muda de driver |
| `SqsDelayTooLongError` no dispatch | Um `delay` acima do limite de 15 minutos do SQS | Limita o delay, ou usa BullMQ/RabbitMQ para delays longos |
| `[basalt:queue] kafka consumer error (queue "…")` no boot | O connect/subscribe ao broker falhou — o processo continua de pé mas **não consome nada** | Corrige brokers/rede e reinicia o worker; alerta nesta linha de log |
| A mesma mensagem Kafka é reentregue repetidamente, com `[basalt:queue] kafka producer error` ao lado | A re-publicação de retry/dead-letter de um job falhado está a falhar, por isso o driver recusa-se a fazer commit do offset — reentrega em vez de perda silenciosa | Restaura o producer/broker; o backlog escoa-se sozinho |
| `[basalt:queue] rabbitmq channel error` depois de um job falhar | A re-publicação de retry não foi confirmada ou o ack falhou; nada foi acked, por isso o broker reentrega a cópia durável | Verifica a saúde do broker; o job em si não precisa de ação |

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

[rmq]: https://github.com/basaltkit/basalt/tree/main/packages/queue-rabbitmq
[sqs]: https://github.com/basaltkit/basalt/tree/main/packages/queue-sqs
[kafka]: https://github.com/basaltkit/basalt/tree/main/packages/queue-kafka

## Ver também

- [Tarefas agendadas](/pt/guide/scheduler) — despacha jobs num horário cron com
  `schedule.job(...)`.
- [Cookbook Notes SaaS](/pt/cookbook/notes-saas) — queues ligadas a uma app real
  (BullMQ + Redis, mailer fora do request).
