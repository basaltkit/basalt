# @machize/queue-rabbitmq

Driver de **RabbitMQ** para o [`@machize/queue`](https://www.npmjs.com/package/@machize/queue): executa os teus jobs sobre AMQP em vez de Redis/BullMQ, sem mudares uma linha do código dos jobs. Precisas deste pacote quando a tua infraestrutura de mensagens já é o RabbitMQ (ou quando queres um message broker dedicado, com routing e dead-lettering nativos).

## O que este módulo resolve

O `@machize/queue` define **jobs** (tarefas em segundo plano) de forma abstrata e escolhe o backend através de um *driver*. Por omissão usa o BullMQ (Redis). Este pacote fornece um driver alternativo que fala com o **RabbitMQ**: os jobs são publicados em filas AMQP duráveis, os workers consomem-nas, e as tentativas/atrasos usam uma *delay queue* com dead-lettering por TTL.

Tudo o resto — `defineJob`, `dispatch`, os workers, a propagação de contexto — continua exatamente igual. Só trocas o driver.

## Instalação

```bash
pnpm add @machize/queue-rabbitmq amqplib
```

O `amqplib` é uma **peer dependency** (instala-o tu): assim quem usa outro driver não arrasta o cliente RabbitMQ. Precisas também de um servidor RabbitMQ acessível.

## Começar em 5 minutos

Define os jobs como sempre (com `@machize/queue`) e passa o driver ao `queuePlugin`:

```ts
import { createApp } from '@machize/core'
import { queuePlugin, defineJob } from '@machize/queue'
import { RabbitmqQueueDriver } from '@machize/queue-rabbitmq'

const SendWelcome = defineJob<{ email: string }>({
  name: 'send-welcome',
  queue: 'emails',
  attempts: 3,
  backoff: { type: 'exponential', delay: '10s' },
  async handle({ email }) {
    // ... enviar o e-mail
  },
})

const app = await createApp({
  plugins: [
    queuePlugin({
      driver: new RabbitmqQueueDriver({ url: process.env.AMQP_URL! }),
      jobs: [SendWelcome],
      workers: [{ queue: 'emails', concurrency: 10 }],
      onUnsupported: 'throw', // opcional: falha se um job pedir algo que o driver não faz
    }),
  ],
}).boot()

await SendWelcome.dispatch({ email: 'ada@acme.test' })
```

## Como funciona

Para cada fila `q`, o driver declara três filas AMQP duráveis:

- **`q`** — a fila principal (com `x-max-priority`, para suportar prioridade).
- **`q.delay`** — buffer de atraso/retry: as mensagens expiram após o seu TTL e fazem *dead-letter* de volta para `q`. É assim que se implementam o `delay` e o `backoff` entre tentativas.
- **`q.dead`** — a *dead-letter queue*: para onde vão os jobs que esgotaram as tentativas.

O número da tentativa viaja nos headers da mensagem (`x-machize-attempt`), por isso o worker sabe quando deve voltar a tentar (via `q.delay`) ou desistir (via `q.dead`).

### Capacidades

| Capacidade | Suportada | Como |
|---|:---:|---|
| `delayed` (entrega atrasada) | ✅ | `q.delay` com TTL por mensagem |
| `priority` | ✅ | `x-max-priority` na fila |
| `retries` | ✅ | re-publicação com contador de tentativas |
| `backoff` | ✅ | TTL na `q.delay` (fixo ou exponencial) |

O driver declara estas `capabilities`, por isso, combinado com `onUnsupported`, um job que peça algo não suportado **falha alto** em vez de ser silenciosamente ignorado.

## Referência da API

### `new RabbitmqQueueDriver(options)`

| Opção | Tipo | Default | Descrição |
|---|---|---|---|
| `url` | `string` | — (obrigatório) | URL AMQP, ex.: `amqp://user:pass@host:5672`. |
| `maxPriority` | `number` | `10` | Nível máximo de prioridade (`x-max-priority`). |
| `connect` | `(url) => Promise<AmqpConnection>` | amqplib | Conector injetável — usado nos testes para não precisar de broker. |

Implementa o contrato `QueueDriver` do `@machize/queue` (`add`, `startWorker`, `setExecutor`, `close`, `capabilities`).

## Ressalva importante

A `q.delay` usa **TTL por mensagem**, e o RabbitMQ só liberta uma mensagem quando ela chega à *cabeça* da fila (head-of-line blocking). Para atrasos muito variados em grande escala, uma mensagem com TTL longo pode bloquear as que estão atrás. Se precisares de atrasos mistos com alta cadência, considera o [RabbitMQ Delayed Message Exchange plugin](https://github.com/rabbitmq/rabbitmq-delayed-message-exchange) — o modelo do driver mantém-se, muda só o mecanismo de atraso.

## Como se liga aos outros módulos

- **`@machize/queue`** — este é um driver desse pacote; toda a API de jobs vem de lá.
- Ver também os drivers irmãos: [`@machize/queue-kafka`](https://www.npmjs.com/package/@machize/queue-kafka) e [`@machize/queue-sqs`](https://www.npmjs.com/package/@machize/queue-sqs), e o guia [Queues & Jobs](https://github.com/Zebedeu/machize) para escrever o teu próprio driver.
