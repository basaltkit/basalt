# Pacotes de driver

Quatro dos módulos de capacidade do Basalt — **queue**, **storage**, **cache** e
**mailer** — passaram os seus backends pesados para pacotes separados. Se estás a
atualizar por cima desses majors, tens aqui tudo o que precisas.

Se estás a começar de novo, lê isto como **uma** ideia em vez de quatro
migrações: **o núcleo define o contrato, o backend é um pacote.**

[[toc]]

## O resumo numa linha

| Núcleo | Era imposto a todos | Agora |
| --- | --- | --- |
| `@basaltkit/queue` **2.x** | `bullmq` | `@basaltkit/queue-bullmq` |
| `@basaltkit/storage` **2.x** | `@aws-sdk/client-s3` + presigner — **4,4 MB** | `@basaltkit/storage-s3` |
| `@basaltkit/cache` **2.x** | `ioredis` — **1,5 MB** | `@basaltkit/cache-redis` |
| `@basaltkit/mailer` **2.x** | `nodemailer` — **688 KB** | `@basaltkit/mailer-smtp` |

Continuas a instalar o núcleo. Ele **não** é um dos backends — é o contrato que
todos implementam, e o pacote que o teu código importa. Um pacote de backend
**depende** do núcleo; nunca o substitui.

## Porque é que estavam acoplados

Cada núcleo oferecia um **atalho de string** para um backend, embutido nas suas
opções:

```ts
queuePlugin({ connection: REDIS_URL })            // → BullMQ
storagePlugin({ disks: { d: { driver: 's3' } } }) // → SDK da AWS
cachePlugin({ driver: 'redis', url })             // → ioredis
mailerPlugin({ driver: 'smtp', smtp: { url } })   // → nodemailer
```

Uma string não pode ser resolvida preguiçosamente. Para o núcleo transformar
`'s3'` num driver, tem de já ter importado o SDK da AWS — portanto **o atalho é o
que forçava a dependência**. Todos os consumidores pagavam por ela, incluindo os
que usavam outro backend: uma app em Azure Blob instalava à mesma 4,4 MB de SDK
da AWS, e uma app que enviava email pelo Resend instalava um cliente SMTP que
nunca abria.

Os satélites que já existiam tornavam isto mais evidente. O
`@basaltkit/queue-rabbitmq`, o `storage-azure`, o `storage-gcs` e o
`cache-tiered` recebiam todos uma *instância* de driver. Um backend por núcleo
era privilegiado; os restantes eram de segunda.

## Migrar

Cada um é um import e uma linha. Nada nos teus jobs, discos, chaves de cache ou
definições de email muda.

### Queue

```bash
pnpm add @basaltkit/queue-bullmq bullmq
```

```diff
+import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'

-queuePlugin({ connection: process.env.REDIS_URL, jobs, workers })
+bullmqQueuePlugin({ connection: process.env.REDIS_URL!, jobs, workers })
```

Todos os backends passam a ter um plugin equivalente — `rabbitmqQueuePlugin`,
`sqsQueuePlugin`, `kafkaQueuePlugin` — por isso trocar de backend é trocar esse
import. Vê [Filas e jobs](/pt/guide/queues).

### Storage

```bash
pnpm add @basaltkit/storage-s3 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

```diff
+import { s3Disk } from '@basaltkit/storage-s3'

 storagePlugin({
   disks: {
     uploads: { driver: 'local', root: './storage' },
-    docs: { driver: 's3', bucket: 'my-app', region: 'eu-west-1' },
+    docs: s3Disk({ bucket: 'my-app', region: 'eu-west-1' }),
   },
 })
```

O `driver: 'local'` fica — não precisa de biblioteca cliente, só de `fs`. Vê
[Storage](/pt/guide/storage).

### Cache

```bash
pnpm add @basaltkit/cache-redis ioredis
```

```diff
+import { redisCache } from '@basaltkit/cache-redis'

-cachePlugin({ driver: 'redis', url: process.env.REDIS_URL })
+cachePlugin({ driver: redisCache(process.env.REDIS_URL!) })
```

O driver em memória por omissão fica no núcleo. Vê [Caching](/pt/guide/caching).

### Mailer

```bash
pnpm add @basaltkit/mailer-smtp nodemailer
```

```diff
+import { smtpMailer } from '@basaltkit/mailer-smtp'

-mailerPlugin({ driver: 'smtp', smtp: { url: process.env.SMTP_URL! }, from })
+mailerPlugin({ driver: smtpMailer({ url: process.env.SMTP_URL! }), from })
```

O `log`, `memory`, `resend`, `ses` e `mailgun` ficam no núcleo — são APIs HTTP ou
destinos locais, e não precisam de biblioteca cliente. Vê
[Notificações](/pt/guide/notifications).

## Isto afeta-me?

Só se usavas um dos quatro atalhos. **Não** és afetado se:

- já passavas uma instância de driver (`storage-azure`, `storage-gcs`,
  `queue-rabbitmq`, `cache-tiered`, ou um teu);
- usavas `driver: 'local'`, a cache em memória por omissão, ou os drivers
  `log`/`memory` do mailer;
- nunca configuraste essa capacidade.

O TypeScript assinala todos os casos em tempo de compilação, porque as strings
removidas saíram das respetivas uniões. O `mailerPlugin({ driver: 'smtp' })`
também lança em runtime com a instrução de migração, para quem venha de
JavaScript ou de um ficheiro de configuração não tipado.

## O que ganhas

Uma app que use o driver local de storage, a cache em memória e o Resend para
email deixa de instalar o SDK da AWS, o ioredis e o nodemailer. São **6,5 MB** de
bibliotecas cliente que nunca chamou.

Também elimina uma incoerência que se tinha tornado difícil de defender:
acrescentar um quinto backend de filas era fácil, mas acrescentar um segundo de
*primeira classe* não era, porque o núcleo tinha um preferido. Agora nenhum
backend é privilegiado, e um driver teu liga-se exatamente onde os incluídos se
ligam.

::: tip Uma regra com que podes contar
Um núcleo de capacidade depende do `@basaltkit/core` e de mais nada. Se
encontrares um que traga um cliente de backend, é um bug — há um teste em todo o
repositório que o impede, e a lista de exceções está vazia.
:::
