# @machize/notifications

Notificações multi-canal para o framework Machize: define uma notificação uma vez e entrega-a por email, dentro da aplicação (o "sininho") ou por canais personalizados (SMS, push, etc.). Precisas deste módulo quando queres avisar utilizadores de que algo aconteceu — "fatura paga", "novo comentário", "subscrição a expirar".

## O que este módulo resolve

Quando algo importante acontece na tua aplicação, normalmente queres avisar o utilizador em mais do que um sítio: um email na caixa de correio e um aviso dentro da própria aplicação, por exemplo. Sem uma camada de notificações, acabas com código de envio espalhado por todo o lado, cada sítio com a sua formatação, e sem forma de o utilizador dizer "não me mandem SMS".

Este módulo introduz o conceito de **notificação declarativa**: com `defineNotification` descreves o nome, os dados (validados com um *schema*, tipicamente [Zod](https://zod.dev)), os **canais** por onde deve sair (um canal é um meio de entrega: `mail`, `inApp`, `sms`, ...) e, para cada canal, uma função que transforma os dados na mensagem certa para esse canal (assunto e texto para email; título e corpo para o feed in-app).

O `Notifier` trata do resto: valida os dados, respeita as preferências do destinatário (opt-out por canal), entrega em todos os canais pedidos e devolve um relatório do que foi enviado, falhou ou foi ignorado. Uma falha num canal nunca impede os outros. Inclui um canal **in-app** pronto a usar (feed de notificações com contagem de não lidas e "marcar como lida") e uma ponte automática para o **@machize/mailer**.

## Instalação

```bash
pnpm add @machize/notifications
```

O pacote depende de `@machize/mailer` (a ponte de email vem incluída). Para validação de dados, instala também `zod`.

## Começar em 5 minutos

1. **Define uma notificação.** `channels` diz por onde sai; `via` diz como se apresenta em cada canal:

```ts
// src/notifications/invoice-paid.ts
import { defineNotification } from '@machize/notifications'
import { z } from 'zod'

export const InvoicePaid = defineNotification({
  name: 'invoice.paid',
  schema: z.object({ number: z.string() }),
  channels: ['mail', 'inApp'],
  via: {
    mail: ({ number }) => ({ subject: `Fatura ${number} paga`, text: `A fatura ${number} foi confirmada.` }),
    inApp: ({ number }) => ({ title: 'Fatura paga', body: `#${number} confirmada`, data: { number } }),
  },
})
```

2. **Regista os plugins.** Ao registar o mailer antes, o canal `mail` é ligado automaticamente; o canal `inApp` vem ativo por omissão (com armazenamento em memória):

```ts
// src/app.ts
import { createApp } from '@machize/core'
import { mailerPlugin } from '@machize/mailer'
import { notificationsPlugin } from '@machize/notifications'

const app = await createApp({
  plugins: [
    mailerPlugin({ driver: 'log', from: 'noreply@aminhaapp.com' }),
    notificationsPlugin(),
  ],
}).boot()
```

3. **Notifica alguém.** O destinatário é qualquer objeto com `id` (e `email` se usares o canal de email) — o tipo `Notifiable`:

```ts
import { NOTIFIER } from '@machize/notifications'
import { InvoicePaid } from './notifications/invoice-paid.js'

const notifier = app.container.get(NOTIFIER)
const ada = { id: 'u1', email: 'ada@example.com' }

const report = await notifier.notify(ada, InvoicePaid, { number: 'INV-7' })
console.log(report)
// { sent: [{ channel: 'mail' }, { channel: 'inApp' }], failed: [], skipped: [] }
```

4. **Lê o feed in-app** (para mostrar o "sininho" na interface):

```ts
import { IN_APP } from '@machize/notifications'

const inApp = app.container.get(IN_APP)
console.log(await inApp.unreadCount('u1'))     // 1
console.log(await inApp.list('u1'))            // notificações, mais recentes primeiro
```

## Guia de utilização

### Preferências do destinatário (opt-out)

O destinatário pode desligar canais com `channelPreferences`. Canais desligados aparecem em `skipped` no relatório:

```ts
const bruno = { id: 'u2', email: 'bruno@example.com', channelPreferences: { mail: false } }
const report = await notifier.notify(bruno, InvoicePaid, { number: 'INV-8' })
// report.skipped === ['mail'] — só recebe in-app
```

### Canais dinâmicos por destinatário

`channels` pode ser uma função que decide os canais consoante o destinatário e os dados:

```ts
import { defineNotification } from '@machize/notifications'

const Ping = defineNotification({
  name: 'ping',
  channels: (recipient) => (recipient.email ? ['mail', 'inApp'] : ['inApp']),
  via: {
    mail: () => ({ subject: 'Ping', text: 'pong' }),
    inApp: () => ({ title: 'Ping' }),
  },
})
```

### Criar um canal personalizado (SMS, push, ...)

Um canal é um objeto com `name` e `send`. O helper `channel()` cria um inline:

```ts
import { channel, notificationsPlugin } from '@machize/notifications'

const sms = channel('sms', async (recipient, message, info) => {
  // message é o que a função via.sms da notificação devolveu
  await oMeuFornecedorDeSms.enviar(recipient['phone'] as string, (message as { text: string }).text)
})

notificationsPlugin({ channels: [sms] })
```

Depois basta a notificação incluir `'sms'` em `channels` e definir `via.sms`.

### Notificar vários destinatários

```ts
const reports = await notifier.notifyMany([ada, bruno], InvoicePaid, { number: 'INV-9' })
// um DeliveryReport por destinatário, pela mesma ordem
```

### Enviar em segundo plano (fila)

Tal como no mailer, `useQueue` faz o `notify()` entregar cada `Delivery` (unidade já renderizada) a um despachante; o worker chama `deliver()`:

```ts
import type { Delivery } from '@machize/notifications'
import { defineJob } from '@machize/queue'

const SendNotification = defineJob({
  name: 'notifications.send',
  handle: (delivery: Delivery) => notifier.deliver(delivery),
})
notifier.useQueue((delivery) => SendNotification.dispatch(delivery))
```

`deliver()` lança em caso de falha, para a fila poder repetir.

### Reagir a envios e falhas (hooks)

O plugin declara dois hooks globais no `HookBus` do Machize:

```ts
app.hooks.on('notification:sent', ({ notification, channel, recipientId }) => { /* métricas */ })
app.hooks.on('notification:failed', ({ notification, channel, recipientId, error }) => { /* alertar */ })
```

## Referência da API

### `defineNotification<T>(definition): NotificationDefinition<T>`

| Campo | Tipo | Obrigatório? | Descrição |
|---|---|---|---|
| `name` | `string` | Sim | Identificador único da notificação |
| `schema` | `NotificationSchema<T>` | Não | Schema com `safeParse` (compatível com Zod) |
| `channels` | `string[] \| ((recipient, data) => string[])` | Sim | Canais de entrega, fixos ou por destinatário |
| `via` | `Record<string, (data, recipient) => unknown>` | Sim | Renderizador por canal — devolve a mensagem desse canal |

Formatos de mensagem esperados pelos canais incluídos: `via.mail` deve devolver `MailChannelMessage` (`{ subject, text?, html? }`); `via.inApp` deve devolver `InAppMessage` (`{ title, body?, data? }`).

### `interface Notifiable`

| Campo | Tipo | Obrigatório? | Descrição |
|---|---|---|---|
| `id` | `string` | Sim | Identificador do destinatário |
| `email` | `string` | Não | Necessário para o canal `mail` |
| `channelPreferences` | `Record<string, boolean>` | Não | `{ sms: false }` desliga o canal `sms` |
| *(outros)* | `unknown` | Não | Campos extra (telefone, tokens push, ...) ficam disponíveis nos canais |

### `class Notifier`

`new Notifier(options: NotifierOptions)` — `options.channels: NotificationChannel[]` (obrigatório), `options.hooks?: HookBus`.

| Método | Assinatura | Descrição |
|---|---|---|
| `notify` | `notify(recipient, definition, data?) => Promise<DeliveryReport>` | Valida, renderiza e entrega em todos os canais; falhas por canal ficam no relatório |
| `notifyMany` | `notifyMany(recipients[], definition, data?) => Promise<DeliveryReport[]>` | `notify` em série para vários destinatários |
| `deliver` | `deliver(delivery: Delivery) => Promise<void>` | Envia uma entrega renderizada pelo respetivo canal; lança em caso de falha |
| `useQueue` | `useQueue(dispatch) => this` | Redireciona as entregas para um despachante (fila) |

`DeliveryReport`: `{ sent: { channel }[], failed: { channel, error }[], skipped: string[] }`.
`Delivery`: `{ notification, channel, recipient, message }`.

### `notificationsPlugin(options?: NotificationsPluginOptions)`

Regista `NOTIFIER` (e `IN_APP` quando o canal in-app está ativo). Se o `MAILER` estiver no contentor, adiciona automaticamente o `MailChannel`.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `channels` | `NotificationChannel[]` | Não | `[]` | Canais extra (sms, push, personalizados) |
| `inApp` | `InAppStore \| false` | Não | `MemoryInAppStore` | Armazenamento in-app; `false` desativa o canal |

### Canal in-app

`InAppStore` (interface a implementar para persistência em base de dados):

| Método | Assinatura | Descrição |
|---|---|---|
| `append` | `(record: InAppNotification) => Promise<void>` | Guarda uma notificação |
| `list` | `(recipientId, { unreadOnly?, limit? }?) => Promise<InAppNotification[]>` | Lista (mais recentes primeiro) |
| `markRead` | `(recipientId, id) => Promise<boolean>` | Marca como lida; `false` se não existir ou já lida |
| `unreadCount` | `(recipientId) => Promise<number>` | Total por ler |

`InAppNotification`: `{ id, recipientId, notification, title, body?, data?, readAt?, at }`.

### Outros exports

| Export | Tipo | Descrição |
|---|---|---|
| `NOTIFIER` / `IN_APP` | tokens | Chaves do `Notifier` e do `InAppStore` no contentor |
| `channel(name, send)` | função | Cria um canal personalizado inline |
| `InAppChannel` / `MailChannel` | classes | Canais incluídos (`new MailChannel(mailer)` para ligar manualmente) |
| `MemoryInAppStore` | classe | Store in-app em memória (dev/testes) |
| `NotificationValidationError` | erro | `NOTIFICATION_INVALID` — dados não passam no schema |
| `UnknownChannelError` | erro | `NOTIFICATION_UNKNOWN_CHANNEL` — canal pedido sem driver registado |
| `MissingRendererError` | erro | `NOTIFICATION_MISSING_RENDERER` — canal pedido sem `via.<canal>` |
| `RecipientEmailMissingError` | erro | `NOTIFICATION_EMAIL_MISSING` — destinatário sem `email` no canal mail |
| `NotificationChannel` | tipo (Avançado) | Contrato de driver de canal: `{ name, send(recipient, message, info) }` |
| `NotificationSchema<T>` | tipo (Avançado) | Contrato estrutural de schema (`safeParse`) |

## Erros comuns e soluções (FAQ)

**`UnknownChannelError`** — A notificação pede um canal (ex.: `sms`) que não foi registado no `Notifier`/plugin. Regista o driver em `notificationsPlugin({ channels: [...] })`. Nota: este erro interrompe o `notify()` — é um erro de configuração, não de entrega.

**`MissingRendererError`** — A notificação lista um canal em `channels` mas não tem a função correspondente em `via`. Adiciona `via.<canal>`.

**O canal `mail` aparece em `failed` com `NOTIFICATION_EMAIL_MISSING`** — O destinatário não tem `email`. Ou garante o email, ou usa `channels` dinâmicos para excluir o canal quando falta.

**O email não sai mas o in-app funciona** — O `MailChannel` só é ligado automaticamente se o `mailerPlugin` estiver registado (idealmente antes do `notificationsPlugin`). Verifica a lista de plugins.

**As notificações in-app desaparecem ao reiniciar** — O `MemoryInAppStore` vive em memória. Em produção, implementa `InAppStore` sobre a tua base de dados e passa-o em `notificationsPlugin({ inApp: minhaStore })`.

**Com `useQueue` nada é entregue** — O `notify()` só enfileira; o worker tem de chamar `notifier.deliver(delivery)`.

## Como se liga aos outros módulos

- **@machize/core** — contentor de dependências (tokens `NOTIFIER`/`IN_APP`) e `HookBus` (hooks `notification:sent`/`notification:failed`).
- **@machize/mailer** — o `MailChannel` converte a mensagem do canal `mail` num email e envia-o pelo `Mailer` registado, herdando o remetente por tenant e a fila do mailer.
- **@machize/queue** — combina com `useQueue` para entregas em segundo plano com retries.
- **@machize/subscriptions** — os hooks de faturação (`billing:subscribed`, `billing:trial_expired`, ...) são o sítio típico para chamar `notifier.notify(...)`.
- **@machize/webhooks** — enquanto este módulo avisa *utilizadores*, o de webhooks avisa *outros sistemas* (por HTTP); usam-se em conjunto para o mesmo evento de domínio.
