# Notifications & mail

Tell a user something happened — "invoice paid", "new comment", "subscription
expiring" — once, and deliver it across every channel they've opted into: email,
an in-app bell, SMS, WhatsApp. [`@basaltkit/notifications`](/reference/packages/notifications)
validates the payload, respects per-recipient preferences, and reports what was
sent, skipped or failed — one channel failing never blocks the others.
[`@basaltkit/mailer`](/reference/packages/mailer) is the email engine underneath
(and works standalone): typed mails, injection-safe HTML templating, and
swappable drivers.

[[toc]]

## Mental model

Two layers, one direction of dependency:

| Layer | Package | Job |
| --- | --- | --- |
| **Notifier** | `@basaltkit/notifications` | One event → many channels (`mail`, `inApp`, `sms`, `whatsapp`, custom), with per-recipient preferences and a delivery report |
| **Mailer** | `@basaltkit/mailer` | One typed mail → one driver (SMTP, Resend, SES, Mailgun, log, memory), with safe HTML templating and header-injection guards |

The `mail` channel bridges the two: when `mailerPlugin` is registered, the
notifier delivers mail through it automatically. Use the mailer directly for
transactional flows that aren't "notifications" (password reset, magic links).

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

`channels` may also be a function `(recipient, data) => string[]` for dynamic
routing. Each `via.<channel>` renderer returns the channel's message shape —
`{ subject, text?, html? }` for mail, `{ title, body?, data? }` for in-app,
`{ body }` for sms/whatsapp.

## Register and send

```ts
import { notificationsPlugin, NOTIFIER } from '@basaltkit/notifications'
import { mailerPlugin } from '@basaltkit/mailer'

app.use(mailerPlugin({ /* … */ })) // the mail channel wires itself when a mailer is present
app.use(notificationsPlugin())      // the inApp channel is on by default

const report = await container.get(NOTIFIER).notify(recipient, InvoicePaid, { amount: 90, number: 'A-1' })
// { sent: [{ channel: 'mail' }, { channel: 'inApp' }], failed: [], skipped: [] }
```

The recipient comes first, then the definition, then the data. It is any
`{ id, email?, phone?, channelPreferences? }` object. Turn a channel off per
recipient with `channelPreferences` (`{ sms: false }`) — disabled channels
appear in `skipped`. A channel that throws lands in `failed` (with the error)
and emits the `notification:failed` hook; successful deliveries emit
`notification:sent`.

## The mailer

### Typed mails

A mail is defined once — name, schema, and renderers — then sent with validated
data and an envelope:

```ts
import { defineMail, html, MAILER } from '@basaltkit/mailer'
import { z } from 'zod'

export const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Welcome, ${name}!`,
  text: ({ name }) => `Hello ${name}`,
  html: ({ name }) => html`<h1>Hello ${name}</h1>`,
})

await container.get(MAILER).send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@acme.io' })
```

Invalid data throws `MailValidationError` before anything is sent. The envelope
is `{ to, from?, cc?, bcc?, replyTo? }`; a missing `to` or `from` (after the
plugin's default) throws `MailIncompleteError`.

### Injection-safe HTML — `` html`` ``, `raw()`, `escapeHtml()`

Mail bodies are usually rendered from **user-controlled** data (names, titles,
comments). Interpolating it bare hands an attacker markup inside mail sent from
your own DKIM/SPF-aligned domain — phishing content, tracking pixels, XSS in
permissive webmail clients. The safe path is the default path: write bodies with
the `` html`` `` tagged template and **every interpolation is escaped
automatically** — remembering to escape is not required, forgetting is not
possible.

```ts
import { html, raw, escapeHtml } from '@basaltkit/mailer'

html`<p>Hi ${userName}</p>`            // userName is escaped — always safe
html`<div>${html`<b>${inner}</b>`}</div>` // nested templates compose, no double-escaping
html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` // arrays render item-by-item
raw('<hr>')                             // trusted markup you wrote — passes through verbatim
escapeHtml(value)                       // manual escaping for hand-built strings
```

`html` returns a `SafeHtml` that stringifies to its markup — drop it straight
into a mail's `html` field. Only ever pass **your own markup** to `raw()`, never
user input.

### Header-injection choke point

Every resolved message passes through the exported `assertHeaderSafe(message)`
before it reaches **any** driver (and again after a queue round-trip): a CR/LF
in the subject or a malformed address in `from`/`to`/`cc`/`bcc`/`replyTo` —
the classic `\r\nBcc: evil@x.com` vector — throws `MailHeaderInjectionError`
(`MAIL_HEADER_INJECTION`, HTTP status 400). You don't call it yourself; it's
the single assembly choke point, so every driver is protected, not just SMTP.

### Drivers

| Driver | `driver:` | Needs | Notes |
| --- | --- | --- | --- |
| Log | `'log'` (default) | — | Prints to a sink (default `console.log`). **Redacts bodies in production** — see below |
| Memory | `'memory'` | — | Captures messages in-process — for tests |
| SMTP | `'smtp'` | `smtp: { … }` | Any SMTP relay |
| Resend | `'resend'` | `resend: { … }` | HTTP API |
| SES | `'ses'` | `ses: { … }` | AWS SES API |
| Mailgun | `'mailgun'` | `mailgun: { … }` | HTTP API |

An unrecognized `driver` string **throws at boot** — it does not silently fall
back to the log driver, because that would print every outbound mail (reset
links included) to stdout in a deploy that only typo'd a config value.

::: warning The log driver redacts bodies in production
With `NODE_ENV=production`, `LogMailDriver` replaces the body with
`(body redacted in production — …)` — mail bodies routinely carry password-reset
links, magic links and tokens, which must not be retained by a log aggregator
just because a deploy was left on the default driver. Dev and test are
unchanged, so your magic links still print locally. Opt back in explicitly with
`logBody: true`.
:::

### Layout, tenant sender, queue, preview

```ts
import { mailerPlugin, tenantFrom } from '@basaltkit/mailer'
import { smtpMailer } from '@basaltkit/mailer-smtp'

mailerPlugin({
  driver: smtpMailer({ url: process.env.SMTP_URL! }),
  from: tenantFrom('noreply@acme.io'),  // reads ctx().tenant.mailFrom, else the fallback
  layout: (body, { mail }) => `<!doctype html><body>${body}</body>`, // shared branding wrapper
})
```

- **`layout`** wraps every HTML body (branding/header/footer); read
  `ctx().tenant` inside for per-tenant branding. Any template engine (MJML,
  React Email, Handlebars…) can render inside `layout` or a mail's own `html()`.
- **Queue** — `mailer.useQueue((m) => SendMail.dispatch(m))` hands resolved
  messages to a `@basaltkit/queue` job whose handler calls `mailer.deliver(m)`.
- **Preview** — declare `previews: [...]` and run `basalt mail:preview` for a
  browser dev server that renders each mail with sample data through the real
  schema validation and `layout`.

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

## Options reference

### `notificationsPlugin(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `channels` | `NotificationChannel[]` | `[]` | Extra channel drivers (sms, push, whatsapp, custom) beyond the built-in `inApp`/`mail` |
| `inApp` | `InAppStore \| false` | in-memory store | Persist the in-app bell; `false` disables the channel entirely |
| `preferences` | `PreferenceStore \| true` | off | Durable per-user opt-outs; `true` uses an in-memory store (dev) |
| `digest` | `DigestStore \| true` | off | Batch low-priority notifications for periodic flushing |

### `mailerPlugin(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `driver` | `'smtp' \| 'log' \| 'memory' \| 'resend' \| 'ses' \| 'mailgun'` | `'log'` | Which transport sends. An unknown string throws at boot (no silent log fallback) |
| `smtp` / `resend` / `ses` / `mailgun` | driver options | — | Required by the matching driver |
| `from` | `string \| (() => string \| undefined)` | — | Default sender; a function resolves per send (`tenantFrom()` for tenant branding) |
| `replyTo` | `string` | — | Default reply-to |
| `layout` | `(html, { mail, data }) => string` | none | Shared HTML wrapper applied to every HTML body |
| `sink` | `(line: string) => void` | `console.log` | Log-driver output target |
| `logBody` | `boolean` | `true` outside production, `false` in production | Log driver only: include the body in the log line — bodies carry reset links/tokens |
| `previews` | `MailPreview[]` | — | Mails exposed by the `basalt mail:preview` dev server |

## Failure modes & troubleshooting

| Error / symptom | Code | When |
| --- | --- | --- |
| `NotificationValidationError` | `NOTIFICATION_INVALID` | Payload fails the notification's Zod schema — nothing is sent |
| `UnknownChannelError` | `NOTIFICATION_UNKNOWN_CHANNEL` | A definition targets a channel with no registered driver (e.g. `sms` without an `SmsChannel`) |
| `MissingRendererError` | `NOTIFICATION_MISSING_RENDERER` | A definition targets a channel but defines no `via.<channel>` renderer |
| `RecipientEmailMissingError` | `NOTIFICATION_EMAIL_MISSING` | Mail channel: recipient has no `email` — lands in the report's `failed`, other channels still deliver |
| `RecipientPhoneMissingError` | `NOTIFICATION_PHONE_MISSING` | SMS/WhatsApp: recipient has no phone — same isolation |
| `MailValidationError` | `MAIL_INVALID` | Mail data fails its schema |
| `MailIncompleteError` | `MAIL_INCOMPLETE` | No recipient in the envelope, or no sender anywhere (envelope or plugin `from`) |
| `MailHeaderInjectionError` | `MAIL_HEADER_INJECTION` | CR/LF or malformed address in subject/from/to/cc/bcc/replyTo — blocked before any driver |
| `MailDeliveryError` | `MAIL_DELIVERY_FAILED` | An API driver (Resend, SES, Mailgun) got a non-success provider response |
| Boot throws `Unknown mail driver "…"` | — | Typo'd `driver` string — fail-loud by design; valid: `smtp, resend, ses, mailgun, memory, log` |
| Mail bodies show `(body redacted in production — …)` | — | Log driver + `NODE_ENV=production`; pass `logBody: true` or configure a real driver |

Pair with [`@basaltkit/i18n`](/guide/i18n) to render outbound content in the
recipient's locale, and [`@basaltkit/queue`](/guide/queues) to deliver
asynchronously.
