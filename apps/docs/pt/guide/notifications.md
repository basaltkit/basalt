# Notifications

Avisa um utilizador de que algo aconteceu — "fatura paga", "novo comentário",
"subscrição a expirar" — uma vez, e entrega em todos os canais em que ele optou:
email, um sino in-app, SMS, WhatsApp. O
[`@basaltkit/notifications`](/reference/packages/notifications) valida o payload,
respeita as preferências por destinatário, e reporta o que foi enviado, saltado ou
falhado — um canal a falhar nunca bloqueia os outros.

## Definir uma notificação

Descreve-a uma vez: os dados (um schema Zod), os canais, e como cada canal a
apresenta.

```ts
import { defineNotification } from '@basaltkit/notifications'
import { z } from 'zod'

export const InvoicePaid = defineNotification({
  name: 'invoice.paid',
  schema: z.object({ amount: z.number(), number: z.string() }),
  channels: ['mail', 'inApp'],
  via: {
    mail: (d) => ({ subject: `Fatura ${d.number} paga`, text: `Recebemos ${d.amount}.` }),
    inApp: (d) => ({ title: 'Fatura paga', body: `${d.number} — ${d.amount}` }),
  },
})
```

## Registar e enviar

```ts
import { notificationsPlugin, NOTIFIER } from '@basaltkit/notifications'
import { mailerPlugin } from '@basaltkit/mailer'

app.use(mailerPlugin({ /* … */ })) // o canal mail liga-se sozinho quando há um mailer
app.use(notificationsPlugin())      // o canal inApp está ligado por omissão

// Sem `driver`, o mail vai para o driver log (stdout). Em produção o corpo da
// mensagem é REDIGIDO — links de reset e tokens não devem ficar retidos num
// agregador de logs (volta a ativar com `logBody: true`). Um nome de driver com
// typo agora falha alto em vez de registar silenciosamente o teu email.

await container.get(NOTIFIER).notify(InvoicePaid, recipient, { amount: 90, number: 'A-1' })
// { sent: [{ channel: 'mail' }, { channel: 'inApp' }], skipped: [], failed: [] }
```

O destinatário é qualquer `{ id, email?, phone?, channelPreferences? }`. Desliga um
canal por destinatário com `channelPreferences` (`{ sms: false }`) — os canais
desligados aparecem em `skipped`.

## SMS & WhatsApp

Entrega sobre um `SmsSender` **provider-agnostic** — implementas um método sobre
Twilio, Vonage, MessageBird, AppyPay… e a framework não depende de nenhum SDK de
provider.

```ts
import { SmsChannel, whatsappChannel, notificationsPlugin } from '@basaltkit/notifications'
import type { SmsSender } from '@basaltkit/notifications'

const twilio: SmsSender = {
  async send({ to, from, body }) {
    await twilioClient.messages.create({ to, from, body })
  },
}

app.use(notificationsPlugin({
  channels: [
    new SmsChannel(twilio, { from: '+15551234567' }),          // canal 'sms'
    whatsappChannel(twilio, { from: 'whatsapp:+15551234567' }), // canal 'whatsapp'
  ],
}))
```

O endereço vem de `recipient.phone` (o `whatsappChannel` prefere
`recipient.whatsapp ?? recipient.phone`). Aponta o `via.sms` / `via.whatsapp` da
notificação para uma mensagem `{ body }`:

```ts
const LowBalance = defineNotification({
  name: 'wallet.low',
  channels: ['sms', 'inApp'],
  via: {
    sms: (d) => ({ body: `Saldo ${d.amount}. Carrega para continuar a enviar.` }),
    inApp: (d) => ({ title: 'Saldo baixo' }),
  },
})
```

Ambos os canais respeitam o opt-out de `channelPreferences` como qualquer canal, e
um destinatário sem número de telefone aparece em `failed` sem bloquear os outros.

## Preferências & digests

Para opt-out durável, por notificação × canal, acrescenta um `PreferenceStore`
(`notificationsPlugin({ preferences })`) — a regra **mais específica** ganha. Para
agrupar notificações de baixa prioridade num resumo periódico, junta-as num
`Digest` e faz `flush()` num agendamento. Vê a
[referência do pacote](/reference/packages/notifications) para a API completa.
