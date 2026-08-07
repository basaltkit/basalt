# @machize/queue-sqs

Driver de **Amazon SQS** para o [`@machize/queue`](https://www.npmjs.com/package/@machize/queue): executa os teus jobs sobre filas SQS geridas pela AWS, sem mudares o código dos jobs. Precisas deste pacote quando corres na AWS e queres uma fila serverless, sem manter Redis nem um broker.

## O que este módulo resolve

O `@machize/queue` define **jobs** de forma abstrata e escolhe o backend por um *driver*. Este pacote fornece um driver que fala com o **SQS**: os jobs são enviados para uma fila SQS e recebidos por *long-polling*.

`defineJob`, `dispatch`, os workers e a propagação de contexto continuam iguais — só trocas o driver.

## Instalação

```bash
pnpm add @machize/queue-sqs @aws-sdk/client-sqs
```

O `@aws-sdk/client-sqs` (AWS SDK v3) é uma **peer dependency**. As credenciais são resolvidas pela cadeia padrão da AWS (variáveis de ambiente, perfil, IAM role…).

## Começar em 5 minutos

O SQS identifica filas por **URL**, por isso passas um resolver `queueUrl` que mapeia o nome da fila (e da sua dead-letter queue) para o URL SQS:

```ts
import { createApp } from '@machize/core'
import { queuePlugin, defineJob } from '@machize/queue'
import { SqsQueueDriver } from '@machize/queue-sqs'

const QUEUE_URLS: Record<string, string> = {
  emails: 'https://sqs.eu-west-1.amazonaws.com/123456789012/emails',
  'emails-dead': 'https://sqs.eu-west-1.amazonaws.com/123456789012/emails-dead',
}

const SendWelcome = defineJob<{ email: string }>({
  name: 'send-welcome',
  queue: 'emails',
  attempts: 3,
  backoff: { type: 'exponential', delay: '30s' },
  async handle({ email }) {
    // ... enviar
  },
})

const app = await createApp({
  plugins: [
    queuePlugin({
      driver: new SqsQueueDriver({ region: 'eu-west-1', queueUrl: (q) => QUEUE_URLS[q]! }),
      jobs: [SendWelcome],
      workers: [{ queue: 'emails', concurrency: 5 }],
    }),
  ],
}).boot()

await SendWelcome.dispatch({ email: 'ada@acme.test' }, { delay: '2m' })
```

## Capacidades — perfil do SQS

| Capacidade | Suportada | Notas |
|---|:---:|---|
| `delayed` (entrega atrasada) | ✅ | `DelaySeconds` nativo, **até 15 minutos** |
| `priority` | ❌ | O SQS não tem prioridade de mensagens |
| `retries` | ✅ | Re-envio com contador de tentativas |
| `backoff` | ✅ | `DelaySeconds` entre tentativas (limitado a 15 min) |

Um `delay` acima de **900 s (15 min)** lança `SqsDelayTooLongError` em vez de o truncar silenciosamente. E como o driver declara `priority: false`, um dispatch com prioridade é apanhado pela política `onUnsupported` do `@machize/queue`.

## Como funciona

- O job é enviado para a fila `emails` com atributos (`x-machize-job`, `x-machize-attempt`, `x-machize-attempts`).
- O worker faz *long-poll* (`ReceiveMessage`), executa o handler, e apaga a mensagem (`DeleteMessage`) em caso de sucesso.
- Em caso de falha: se ainda há tentativas, re-envia com `DelaySeconds` (o backoff, limitado a 15 min) e apaga a original; se esgotou, envia para a **dead-letter queue** `emails-dead` (sufixo configurável) e apaga a original.

> Deves criar as filas SQS (principal e dead-letter) previamente e mapeá-las no resolver `queueUrl` — incluindo a `<fila><deadSuffix>`.

## Referência da API

### `new SqsQueueDriver(options)`

| Opção | Tipo | Default | Descrição |
|---|---|---|---|
| `queueUrl` | `(queue: string) => string` | — (obrigatório) | Mapeia um nome de fila para o seu URL SQS. Tem de resolver também a dead-letter queue. |
| `region` | `string` | (SDK) | Região AWS. |
| `deadSuffix` | `string` | `'-dead'` | Sufixo para o nome da dead-letter queue. |
| `waitTimeSeconds` | `number` | `20` | Duração do long-poll. |
| `visibilityTimeout` | `number` | `30` | Visibility timeout enquanto a mensagem é processada. |
| `api` | `SqsApi` | AWS SDK | API injetável — usada nos testes sem AWS. |

Constantes/erros exportados: `SQS_MAX_DELAY_SECONDS` (900) e `SqsDelayTooLongError`.

## Como se liga aos outros módulos

- **`@machize/queue`** — este é um driver desse pacote; a API de jobs vem de lá.
- Drivers irmãos: [`@machize/queue-rabbitmq`](https://www.npmjs.com/package/@machize/queue-rabbitmq) e [`@machize/queue-kafka`](https://www.npmjs.com/package/@machize/queue-kafka).
