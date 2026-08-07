# @machize/queue-kafka

Driver de **Apache Kafka** para o [`@machize/queue`](https://www.npmjs.com/package/@machize/queue): executa os teus jobs produzindo e consumindo mensagens em tópicos Kafka, sem mudares o código dos jobs. Precisas deste pacote quando a tua plataforma de dados já assenta em Kafka e queres processar trabalho em segundo plano sobre a mesma infraestrutura.

## O que este módulo resolve

O `@machize/queue` define **jobs** de forma abstrata e escolhe o backend por um *driver*. Este pacote fornece um driver que fala com o **Kafka**: os jobs são produzidos num tópico e consumidos por um *consumer group*.

`defineJob`, `dispatch`, os workers e a propagação de contexto continuam iguais — só trocas o driver.

## Instalação

```bash
pnpm add @machize/queue-kafka kafkajs
```

O `kafkajs` é uma **peer dependency**. Precisas de um cluster Kafka acessível.

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { queuePlugin, defineJob } from '@machize/queue'
import { KafkaQueueDriver } from '@machize/queue-kafka'

const IndexDocument = defineJob<{ id: string }>({
  name: 'index-document',
  queue: 'indexing',
  attempts: 3,
  async handle({ id }) {
    // ... indexar
  },
})

const app = await createApp({
  plugins: [
    queuePlugin({
      driver: new KafkaQueueDriver({ brokers: ['localhost:9092'], clientId: 'my-app' }),
      jobs: [IndexDocument],
      workers: [{ queue: 'indexing', concurrency: 4 }],
    }),
  ],
}).boot()

await IndexDocument.dispatch({ id: 'doc-1' })
```

## Honestidade sobre o Kafka

O Kafka é um **log distribuído**, não uma *task queue* — e o driver é deliberadamente honesto sobre isso nas suas `capabilities`:

| Capacidade | Suportada | Porquê |
|---|:---:|---|
| `delayed` (entrega atrasada) | ❌ | O Kafka não adia mensagens. |
| `priority` | ❌ | O Kafka não tem prioridade de mensagens. |
| `retries` | ✅ | Via um *retry topic* que o worker também consome. |
| `backoff` | ❌ | Sem atraso entre tentativas (o Kafka não defere). |

Como o driver **declara** isto, um job que peça `delay` ou `priority` é apanhado pela política `onUnsupported` do `@machize/queue`:

```ts
queuePlugin({ driver: new KafkaQueueDriver({ brokers }), onUnsupported: 'throw' })
await Job.dispatch(payload, { delay: '5m' }) // → lança UnsupportedJobOptionError
// com onUnsupported: 'warn' (default) → avisa uma vez e corre já
```

> Se o que precisas é de *streaming*/pub-sub (e não jobs com retry/atraso), o encaixe natural no Machize costuma ser o `@machize/events`, não o `@machize/queue`.

## Como funciona

Para cada fila `t`:

- **`t`** — o tópico principal onde os jobs são produzidos.
- **`t.retry`** — tópico de re-tentativa que o worker também subscreve; um job falhado é re-produzido aqui com o contador de tentativas incrementado.
- **`t.dead`** — tópico de dead-letter para jobs que esgotaram as tentativas.

A concorrência do worker é passada a `partitionsConsumedConcurrently` — o paralelismo real é limitado pelo **número de partições** do tópico, não por um número arbitrário.

## Referência da API

### `new KafkaQueueDriver(options)`

| Opção | Tipo | Default | Descrição |
|---|---|---|---|
| `brokers` | `string[]` | — (obrigatório) | Lista de brokers, ex.: `['localhost:9092']`. |
| `clientId` | `string` | `'machize'` | Client id do Kafka. |
| `groupId` | `string` | `'machize-queue'` | Consumer group dos workers. |
| `retrySuffix` | `string` | `'.retry'` | Sufixo do tópico de re-tentativa. |
| `deadSuffix` | `string` | `'.dead'` | Sufixo do tópico de dead-letter. |
| `client` | `KafkaClient` | kafkajs | Cliente injetável — usado nos testes sem broker. |

Implementa o contrato `QueueDriver` do `@machize/queue`.

## Como se liga aos outros módulos

- **`@machize/queue`** — este é um driver desse pacote; a API de jobs vem de lá.
- Drivers irmãos: [`@machize/queue-rabbitmq`](https://www.npmjs.com/package/@machize/queue-rabbitmq) e [`@machize/queue-sqs`](https://www.npmjs.com/package/@machize/queue-sqs).
