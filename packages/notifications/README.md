<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/notifications

Multi-channel notifications for the Basalt framework: define a notification once and deliver it by email, in-app (the "bell"), or through custom channels (SMS, push, etc.). You need this module when you want to let users know something happened — "invoice paid", "new comment", "subscription expiring".

## What this module solves

When something important happens in your application, you usually want to notify the user in more than one place: an email in their inbox and an alert inside the application itself, for example. Without a notifications layer, you end up with sending code scattered everywhere, each place with its own formatting, and no way for the user to say "don't send me SMS".

This module introduces the concept of a **declarative notification**: with `defineNotification` you describe the name, the data (validated with a *schema*, typically [Zod](https://zod.dev)), the **channels** it should go out through (a channel is a delivery medium: `mail`, `inApp`, `sms`, ...), and, for each channel, a function that turns the data into the right message for that channel (subject and text for email; title and body for the in-app feed).

`Notifier` handles the rest: it validates the data, respects the recipient's preferences (per-channel opt-out), delivers on all requested channels, and returns a report of what was sent, failed, or skipped. A failure on one channel never blocks the others. It includes a ready-to-use **in-app** channel (notification feed with unread count and "mark as read") and an automatic bridge to **@basaltkit/mailer**.

## Installation

```bash
pnpm add @basaltkit/notifications
```

The package depends on `@basaltkit/mailer` (the email bridge is included). For data validation, also install `zod`.

## Get started in 5 minutes

1. **Define a notification.** `channels` says where it goes out; `via` says how it's presented on each channel:

```ts
// src/notifications/invoice-paid.ts
import { defineNotification } from '@basaltkit/notifications'
import { z } from 'zod'

export const InvoicePaid = defineNotification({
  name: 'invoice.paid',
  schema: z.object({ number: z.string() }),
  channels: ['mail', 'inApp'],
  via: {
    mail: ({ number }) => ({ subject: `Invoice ${number} paid`, text: `Invoice ${number} has been confirmed.` }),
    inApp: ({ number }) => ({ title: 'Invoice paid', body: `#${number} confirmed`, data: { number } }),
  },
})
```

2. **Register the plugins.** By registering the mailer first, the `mail` channel is wired up automatically; the `inApp` channel is active by default (with in-memory storage):

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { mailerPlugin } from '@basaltkit/mailer'
import { notificationsPlugin } from '@basaltkit/notifications'

const app = await createApp({
  plugins: [
    mailerPlugin({ driver: 'log', from: 'noreply@myapp.com' }),
    notificationsPlugin(),
  ],
}).boot()
```

3. **Notify someone.** The recipient is any object with `id` (and `email` if you use the email channel) — the `Notifiable` type:

```ts
import { NOTIFIER } from '@basaltkit/notifications'
import { InvoicePaid } from './notifications/invoice-paid.js'

const notifier = app.container.get(NOTIFIER)
const ada = { id: 'u1', email: 'ada@example.com' }

const report = await notifier.notify(ada, InvoicePaid, { number: 'INV-7' })
console.log(report)
// { sent: [{ channel: 'mail' }, { channel: 'inApp' }], failed: [], skipped: [] }
```

4. **Read the in-app feed** (to show the "bell" in the UI):

```ts
import { IN_APP } from '@basaltkit/notifications'

const inApp = app.container.get(IN_APP)
console.log(await inApp.unreadCount('u1'))     // 1
console.log(await inApp.list('u1'))            // notifications, most recent first
```

## Usage guide

### Recipient preferences (opt-out)

The recipient can turn off channels with `channelPreferences`. Disabled channels appear in `skipped` on the report:

```ts
const bruno = { id: 'u2', email: 'bruno@example.com', channelPreferences: { mail: false } }
const report = await notifier.notify(bruno, InvoicePaid, { number: 'INV-8' })
// report.skipped === ['mail'] — only receives in-app
```

### Persistable preferences (per notification × channel)

`channelPreferences` above is inline on the recipient object. For **durable,
finer-grained** opt-outs, enable `NotificationPreferences` (backed by a
`PreferenceStore`): a user can silence a specific notification on a specific
channel, and the **most-specific** preference wins.

```ts
import { notificationsPlugin, PREFERENCES } from '@basaltkit/notifications'

notificationsPlugin({ preferences: true }) // in-memory; pass a store in production

const prefs = container.get(PREFERENCES)
await prefs.optOut('u2', { channel: 'sms' })                         // no SMS at all
await prefs.optOut('u2', { notification: 'invoice.paid' })           // never for invoice.paid
await prefs.optIn('u2', { notification: 'security.alert', channel: 'sms' }) // …but keep this one
```

The plugin passes these to the `Notifier` automatically, which **skips** any
channel a user opted out of (reported in `skipped`). Everything is allowed by
default; back the `PreferenceStore` with your database in production.

### Digest (batching)

Instead of sending immediately, hold notifications and flush them as one batch —
a daily summary, say. Enable `digest: true` and use the `DIGEST` token:

```ts
import { notificationsPlugin, DIGEST, NOTIFIER } from '@basaltkit/notifications'

notificationsPlugin({ digest: true }) // in-memory; pass a store in production

const digest = container.get(DIGEST)
await digest.collect(user, UsageAlert, { used: 900 }) // renders + holds, does NOT send

// later, on a schedule (@basaltkit/scheduler), send each recipient's batch once:
await digest.flush(async ({ recipientId, channel, items }) => {
  await container.get(NOTIFIER).deliver({
    notification: 'digest', channel, recipient: { id: recipientId }, message: { items },
  })
})
```

`collect()` renders through the notification's `via` and groups by
recipient + channel; `flush()` sends each group once and clears it. You decide how
to render the combined message.

### Dynamic channels per recipient

`channels` can be a function that decides the channels based on the recipient and the data:

```ts
import { defineNotification } from '@basaltkit/notifications'

const Ping = defineNotification({
  name: 'ping',
  channels: (recipient) => (recipient.email ? ['mail', 'inApp'] : ['inApp']),
  via: {
    mail: () => ({ subject: 'Ping', text: 'pong' }),
    inApp: () => ({ title: 'Ping' }),
  },
})
```

### Creating a custom channel (SMS, push, ...)

A channel is an object with `name` and `send`. The `channel()` helper creates one inline:

```ts
import { channel, notificationsPlugin } from '@basaltkit/notifications'

const sms = channel('sms', async (recipient, message, info) => {
  // message is whatever the notification's via.sms function returned
  await mySmsProvider.send(recipient['phone'] as string, (message as { text: string }).text)
})

notificationsPlugin({ channels: [sms] })
```

Then the notification just needs to include `'sms'` in `channels` and define `via.sms`.

### Built-in SMS & WhatsApp channels

You don't have to hand-roll the SMS channel — `SmsChannel` ships with the module.
It delivers over a **provider-agnostic** `SmsSender`, so the framework never
depends on Twilio, Vonage, MessageBird or any SDK; you implement one tiny method:

```ts
import { SmsChannel, whatsappChannel, notificationsPlugin } from '@basaltkit/notifications'
import type { SmsSender } from '@basaltkit/notifications'

const twilio: SmsSender = {
  async send({ to, from, body }) {
    await twilioClient.messages.create({ to, from, body })
  },
}

notificationsPlugin({
  channels: [
    new SmsChannel(twilio, { from: '+15551234567' }),        // channel 'sms'
    whatsappChannel(twilio, { from: 'whatsapp:+15551234567' }), // channel 'whatsapp'
  ],
})
```

The recipient's address comes from `recipient.phone` by default (add a `phone`
field to your `Notifiable`); `whatsappChannel` reads `recipient.whatsapp ?? recipient.phone`.
Point the notification's `via.sms` / `via.whatsapp` at a `{ body }` message:

```ts
const LowBalance = defineNotification({
  name: 'wallet.low',
  channels: ['sms', 'inApp'],
  via: {
    sms: (data) => ({ body: `Your balance is ${data.amount}. Top up to keep sending.` }),
    inApp: (data) => ({ title: 'Low balance', body: `${data.amount} left` }),
  },
})
```

Both channels honour per-recipient opt-out through `channelPreferences`
(`{ sms: false }`) exactly like `mail` and `inApp`. A recipient with no address
is reported in `failed` — one channel failing never blocks the others.

### Notifying multiple recipients

```ts
const reports = await notifier.notifyMany([ada, bruno], InvoicePaid, { number: 'INV-9' })
// one DeliveryReport per recipient, in the same order
```

### Sending in the background (queue)

Just like the mailer, `useQueue` makes `notify()` hand each `Delivery` (an already-rendered unit) off to a dispatcher; the worker calls `deliver()`:

```ts
import type { Delivery } from '@basaltkit/notifications'
import { defineJob } from '@basaltkit/queue'

const SendNotification = defineJob({
  name: 'notifications.send',
  handle: (delivery: Delivery) => notifier.deliver(delivery),
})
notifier.useQueue((delivery) => SendNotification.dispatch(delivery))
```

`deliver()` throws on failure, so the queue can retry.

### Reacting to sends and failures (hooks)

The plugin declares two global hooks on Basalt's `HookBus`:

```ts
app.hooks.on('notification:sent', ({ notification, channel, recipientId }) => { /* metrics */ })
app.hooks.on('notification:failed', ({ notification, channel, recipientId, error }) => { /* alert */ })
```

## API reference

### `defineNotification<T>(definition): NotificationDefinition<T>`

| Field | Type | Required? | Description |
|---|---|---|---|
| `name` | `string` | Yes | Unique notification identifier |
| `schema` | `NotificationSchema<T>` | No | Schema with `safeParse` (Zod-compatible) |
| `channels` | `string[] \| ((recipient, data) => string[])` | Yes | Delivery channels, fixed or per recipient |
| `via` | `Record<string, (data, recipient) => unknown>` | Yes | Per-channel renderer — returns that channel's message |

Message formats expected by the included channels: `via.mail` should return `MailChannelMessage` (`{ subject, text?, html? }`); `via.inApp` should return `InAppMessage` (`{ title, body?, data? }`).

### `interface Notifiable`

| Field | Type | Required? | Description |
|---|---|---|---|
| `id` | `string` | Yes | Recipient identifier |
| `email` | `string` | No | Required for the `mail` channel |
| `channelPreferences` | `Record<string, boolean>` | No | `{ sms: false }` disables the `sms` channel |
| *(other)* | `unknown` | No | Extra fields (phone, push tokens, ...) are available to channels |

### `class Notifier`

`new Notifier(options: NotifierOptions)` — `options.channels: NotificationChannel[]` (required), `options.hooks?: HookBus`.

| Method | Signature | Description |
|---|---|---|
| `notify` | `notify(recipient, definition, data?) => Promise<DeliveryReport>` | Validates, renders, and delivers on all channels; per-channel failures land in the report |
| `notifyMany` | `notifyMany(recipients[], definition, data?) => Promise<DeliveryReport[]>` | `notify` in series for multiple recipients |
| `deliver` | `deliver(delivery: Delivery) => Promise<void>` | Sends an already-rendered delivery via its channel; throws on failure |
| `useQueue` | `useQueue(dispatch) => this` | Redirects deliveries to a dispatcher (queue) |

`DeliveryReport`: `{ sent: { channel }[], failed: { channel, error }[], skipped: string[] }`.
`Delivery`: `{ notification, channel, recipient, message }`.

### `notificationsPlugin(options?: NotificationsPluginOptions)`

Registers `NOTIFIER` (and `IN_APP` when the in-app channel is active). If `MAILER` is in the container, automatically adds the `MailChannel`.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `channels` | `NotificationChannel[]` | No | `[]` | Extra channels (sms, push, custom) |
| `inApp` | `InAppStore \| false` | No | `MemoryInAppStore` | In-app storage; `false` disables the channel |

### In-app channel

`InAppStore` (interface to implement for database persistence):

| Method | Signature | Description |
|---|---|---|
| `append` | `(record: InAppNotification) => Promise<void>` | Stores a notification |
| `list` | `(recipientId, { unreadOnly?, limit? }?) => Promise<InAppNotification[]>` | Lists (most recent first) |
| `markRead` | `(recipientId, id) => Promise<boolean>` | Marks as read; `false` if it doesn't exist or is already read |
| `unreadCount` | `(recipientId) => Promise<number>` | Total unread |

`InAppNotification`: `{ id, recipientId, notification, title, body?, data?, readAt?, at }`.

### Other exports

| Export | Type | Description |
|---|---|---|
| `NOTIFIER` / `IN_APP` | tokens | Container keys for `Notifier` and `InAppStore` |
| `channel(name, send)` | function | Creates a custom channel inline |
| `InAppChannel` / `MailChannel` | classes | Included channels (`new MailChannel(mailer)` to wire manually) |
| `MemoryInAppStore` | class | In-memory in-app store (dev/testing) |
| `NotificationValidationError` | error | `NOTIFICATION_INVALID` — data doesn't pass the schema |
| `UnknownChannelError` | error | `NOTIFICATION_UNKNOWN_CHANNEL` — requested channel has no registered driver |
| `MissingRendererError` | error | `NOTIFICATION_MISSING_RENDERER` — requested channel has no `via.<channel>` |
| `RecipientEmailMissingError` | error | `NOTIFICATION_EMAIL_MISSING` — recipient has no `email` for the mail channel |
| `NotificationChannel` | type (Advanced) | Channel driver contract: `{ name, send(recipient, message, info) }` |
| `NotificationSchema<T>` | type (Advanced) | Structural schema contract (`safeParse`) |

## Common issues and solutions (FAQ)

**`UnknownChannelError`** — The notification requests a channel (e.g. `sms`) that wasn't registered with `Notifier`/plugin. Register the driver in `notificationsPlugin({ channels: [...] })`. Note: this error interrupts `notify()` — it's a configuration error, not a delivery error.

**`MissingRendererError`** — The notification lists a channel in `channels` but has no corresponding function in `via`. Add `via.<channel>`.

**The `mail` channel appears in `failed` with `NOTIFICATION_EMAIL_MISSING`** — The recipient has no `email`. Either ensure the email is present, or use dynamic `channels` to exclude the channel when it's missing.

**Email doesn't go out but in-app works** — `MailChannel` is only wired automatically if `mailerPlugin` is registered (ideally before `notificationsPlugin`). Check the plugin list.

**In-app notifications disappear on restart** — `MemoryInAppStore` lives in memory. In production, implement `InAppStore` over your database and pass it via `notificationsPlugin({ inApp: myStore })`.

**With `useQueue` nothing gets delivered** — `notify()` only enqueues; the worker must call `notifier.deliver(delivery)`.

## How it connects to other modules

- **@basaltkit/core** — dependency container (`NOTIFIER`/`IN_APP` tokens) and `HookBus` (hooks `notification:sent`/`notification:failed`).
- **@basaltkit/mailer** — `MailChannel` converts the `mail` channel's message into an email and sends it through the registered `Mailer`, inheriting the per-tenant sender and the mailer's queue.
- **@basaltkit/queue** — combine with `useQueue` for background delivery with retries.
- **@basaltkit/subscriptions** — billing hooks (`billing:subscribed`, `billing:trial_expired`, ...) are the typical place to call `notifier.notify(...)`.
- **@basaltkit/webhooks** — while this module notifies *users*, the webhooks module notifies *other systems* (via HTTP); they're often used together for the same domain event.
