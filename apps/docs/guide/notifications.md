# Notifications

Tell a user something happened — "invoice paid", "new comment", "subscription
expiring" — once, and deliver it across every channel they've opted into: email,
an in-app bell, SMS, WhatsApp. [`@basaltkit/notifications`](/reference/packages/notifications)
validates the payload, respects per-recipient preferences, and reports what was
sent, skipped or failed — one channel failing never blocks the others.

## Define a notification

Describe it once: the data (a Zod schema), the channels, and how each channel
presents it.

```ts
import { defineNotification } from '@basaltkit/notifications'
import { z } from 'zod'

export const InvoicePaid = defineNotification({
  name: 'invoice.paid',
  schema: z.object({ amount: z.number(), number: z.string() }),
  channels: ['mail', 'inApp'],
  via: {
    mail: (d) => ({ subject: `Invoice ${d.number} paid`, text: `We received ${d.amount}.` }),
    inApp: (d) => ({ title: 'Invoice paid', body: `${d.number} — ${d.amount}` }),
  },
})
```

## Register and send

```ts
import { notificationsPlugin, NOTIFIER } from '@basaltkit/notifications'
import { mailerPlugin } from '@basaltkit/mailer'

app.use(mailerPlugin({ /* … */ })) // the mail channel wires itself when a mailer is present
app.use(notificationsPlugin())      // the inApp channel is on by default

// Without a `driver`, mail goes to the log driver (stdout). In production it
// REDACTS message bodies — reset links and tokens must not end up retained by a
// log aggregator (opt back in with `logBody: true`). A typo'd driver name now
// fails loud instead of silently logging your outbound mail.

await container.get(NOTIFIER).notify(InvoicePaid, recipient, { amount: 90, number: 'A-1' })
// { sent: [{ channel: 'mail' }, { channel: 'inApp' }], skipped: [], failed: [] }
```

The recipient is any `{ id, email?, phone?, channelPreferences? }`. Turn a channel
off per recipient with `channelPreferences` (`{ sms: false }`) — disabled channels
appear in `skipped`.

## SMS & WhatsApp

Deliver over a **provider-agnostic** `SmsSender` — implement one method over
Twilio, Vonage, MessageBird, AppyPay… and the framework depends on no provider SDK.

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
    new SmsChannel(twilio, { from: '+15551234567' }),          // channel 'sms'
    whatsappChannel(twilio, { from: 'whatsapp:+15551234567' }), // channel 'whatsapp'
  ],
}))
```

The address comes from `recipient.phone` (`whatsappChannel` prefers
`recipient.whatsapp ?? recipient.phone`). Point the notification's `via.sms` /
`via.whatsapp` at a `{ body }` message:

```ts
const LowBalance = defineNotification({
  name: 'wallet.low',
  channels: ['sms', 'inApp'],
  via: {
    sms: (d) => ({ body: `Balance ${d.amount}. Top up to keep sending.` }),
    inApp: (d) => ({ title: 'Low balance' }),
  },
})
```

Both channels honour `channelPreferences` opt-out like every channel, and a
recipient with no phone number surfaces in `failed` without blocking the others.

## Preferences & digests

For durable, per-notification × channel opt-out, add a `PreferenceStore`
(`notificationsPlugin({ preferences })`) — the **most-specific** rule wins. To
batch low-priority notifications into a periodic summary, collect them into a
`Digest` and `flush()` on a schedule. See the
[package reference](/reference/packages/notifications) for the full API.
