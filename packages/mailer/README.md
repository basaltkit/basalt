<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/mailer

Email layer for the Basalt framework: define typed emails once and send them via SMTP, an API provider (Resend or Amazon SES), to the console (development), or to memory (tests). You need this module whenever your application has to send emails — welcome messages, invoices, password recovery, etc.

## What this module solves

Sending an email seems simple, but in practice there are several hidden problems: making sure the data used in the email text is correct (you don't want to send "Hello undefined"), not repeating the sender address everywhere, being able to test without sending real emails, and not blocking the application while the mail server responds.

This module solves that with the concept of a **typed email**: you describe each email once with `defineMail` — the name, the data it needs (validated with a *schema*, i.e. a formal description of the data shape, usually built with the [Zod](https://zod.dev) library), the subject, and the body. Then, to send it, you call `mailer.send(...)` with the data and the recipient. If the data is wrong, sending fails immediately with a clear error, before any email goes out.

The actual sending is done by a **driver** (the component that knows how to talk to the outside world). Six are included: `smtp` (via nodemailer), `resend`, `ses` and `mailgun` (API providers over HTTPS, no SDK), `log` (console — dev), and `memory` (array — tests). You can switch drivers without changing a single line of the rest of the code.

## Installation

```bash
pnpm add @basaltkit/mailer
```

If you want to validate email data (recommended), also install Zod:

```bash
pnpm add zod
```

## Get started in 5 minutes

1. **Define an email** with `defineMail`. The `schema` describes the data; `subject`, `text`, and `html` are functions that receive that data and return text:

```ts
// src/mails/welcome.ts
import { defineMail } from '@basaltkit/mailer'
import { z } from 'zod'

export const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Welcome, ${name}!`,
  text: ({ name }) => `Hello ${name}`,
  html: ({ name }) => `<h1>Hello ${name}</h1>`,
})
```

2. **Register the plugin** on your Basalt application. In development, use the `log` driver (the default), which just prints to the console:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { mailerPlugin } from '@basaltkit/mailer'

const app = await createApp({
  plugins: [
    mailerPlugin({ driver: 'log', from: 'noreply@myapp.com' }),
  ],
}).boot()
```

3. **Send the email.** Get the `Mailer` from the application container via the `MAILER` token (a *token* is the "key" you use to request a registered service from the Basalt dependency container):

```ts
import { MAILER } from '@basaltkit/mailer'
import { WelcomeEmail } from './mails/welcome.js'

const mailer = app.container.get(MAILER)
await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })
```

4. You'll see something like this in the console:

```
[mail] welcome → ada@example.com | Welcome, Ada!
Hello Ada
```

5. **In production**, switch the plugin to a real driver — SMTP, or an API
   provider (**Resend** or **Amazon SES**, both over HTTPS, no SDK):

```ts
// SMTP (any mail server)
mailerPlugin({ driver: 'smtp', smtp: { url: 'smtps://user:password@smtp.example.com:465' }, from: 'noreply@myapp.com' })

// Resend — https API, just an API key
mailerPlugin({ driver: 'resend', resend: { apiKey: process.env.RESEND_API_KEY! }, from: 'noreply@myapp.com' })

// Amazon SES v2 — signed (SigV4) with your AWS credentials
mailerPlugin({
  driver: 'ses',
  ses: { region: 'eu-west-1', accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
  from: 'noreply@myapp.com',
})

// Mailgun — API key + sending domain (region: 'us' | 'eu')
mailerPlugin({ driver: 'mailgun', mailgun: { apiKey: process.env.MAILGUN_KEY!, domain: 'mg.myapp.com' }, from: 'noreply@myapp.com' })
```

### Layouts & templates

`defineMail`'s `html(data)` returns a string, so **any template engine works** —
plain template literals, [MJML](https://mjml.io) (`mjml2html(...)`), or
[React Email](https://react.email) (`render(<Email/>)`). Render inside `html()`.

For shared branding (header/footer, per-tenant colours), pass a `layout` — it
wraps every mail's HTML body once:

```ts
mailerPlugin({
  driver: 'smtp',
  smtp: { url: process.env.SMTP_URL! },
  from: 'noreply@myapp.com',
  layout: (body, { mail }) => `<!doctype html><html><body style="font-family:sans-serif">
    <img src="https://myapp.com/logo.png" height="32"/>
    ${body}
    <footer>Sent by MyApp · ${mail}</footer>
  </body></html>`,
})
```

The `layout` runs per send, so it can read `ctx().tenant` for per-tenant branding.
It only applies when the mail has an HTML body.

> All drivers share the same envelope and the framework's header-injection guard.
> SES also works via the `smtp` driver using SES SMTP credentials.

## Usage guide

### Defining emails (templates)

An "email template" here is a definition in code: name + schema + rendering functions. Emails without data are also possible (omit the `schema` and skip the parameter):

```ts
import { defineMail } from '@basaltkit/mailer'

const Ping = defineMail({ name: 'ping', subject: () => 'Ping', text: () => 'pong' })

// Sending an email without data: you only pass the envelope
await mailer.send(Ping, { to: 'a@b.c' })
```

### The envelope (recipients and sender)

The **envelope** is the set of addresses for the send. Only `to` is required; `from` can come from the envelope or from the `Mailer` configuration:

```ts
await mailer.send(WelcomeEmail, { name: 'Ada' }, {
  to: ['ada@example.com', 'grace@example.com'],
  cc: 'boss@example.com',
  bcc: ['audit@example.com'],
  replyTo: 'support@myapp.com',
  from: 'special@myapp.com', // optional — overrides the default
})
```

If `to` or `from` is missing, a `MailIncompleteError` is thrown (code `MAIL_INCOMPLETE`).

### Sender per tenant (multi-tenant)

In a multi-tenant SaaS application (several customers on the same application), each customer may want its own sender. The `from` option accepts a function, evaluated on each send. The `tenantFrom` helper reads `ctx().tenant.mailFrom` from the request context:

```ts
import { mailerPlugin, tenantFrom } from '@basaltkit/mailer'

mailerPlugin({ driver: 'smtp', smtp: { url: process.env.SMTP_URL! }, from: tenantFrom('fallback@myapp.com') })
```

Inside a request whose context has `tenant.mailFrom`, that address is used; otherwise, the fallback is used.

### Sending in the background (queue)

By default, `send()` sends immediately (blocks until the driver finishes). With `useQueue`, `send()` instead delivers the already-rendered message to a dispatcher — typically a `@basaltkit/queue` job — and the worker calls `deliver()`:

```ts
import { defineJob } from '@basaltkit/queue'
import type { ResolvedMail } from '@basaltkit/mailer'

const SendMail = defineJob({ name: 'mailer.send', handle: (m: ResolvedMail) => mailer.deliver(m) })
mailer.useQueue((m) => SendMail.dispatch(m))
```

### Testing without sending anything

`MemoryMailDriver` stores everything you "sent":

```ts
import { Mailer, MemoryMailDriver } from '@basaltkit/mailer'

const driver = new MemoryMailDriver()
const mailer = new Mailer(driver, { from: 'noreply@test.dev' })

await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })

console.log(driver.sent.length)            // 1
console.log(driver.ofMail('welcome')[0])   // the resolved message
```

### Previewing mails in the browser

See exactly what a driver would send — subject, HTML (layout and all), and text —
without sending anything. Register previews with sample data and run the dev server:

```ts
import { mailerPlugin, definePreview } from '@basaltkit/mailer'
import { WelcomeEmail, InvoiceEmail } from './mails.js'

mailerPlugin({
  driver: 'smtp',
  smtp: { url: process.env.SMTP_URL! },
  from: 'noreply@myapp.com',
  layout: (body, { mail }) => `<html><body>${body}<footer>${mail}</footer></body></html>`,
  previews: [
    definePreview({ mail: WelcomeEmail, data: { name: 'Ada' } }),
    definePreview({ mail: InvoiceEmail, data: { total: 4200, currency: 'AOA' }, label: 'Invoice · paid' }),
  ],
})
```

```bash
basalt mail:preview --port=3737   # → http://127.0.0.1:3737
```

The preview reuses the mailer's own `resolve` (schema validation + `layout`), so
the render is faithful. Invalid sample data shows an error card instead of
crashing. Need it without the CLI? Use the server directly:

```ts
import { createMailPreviewServer } from '@basaltkit/mailer'

const server = createMailPreviewServer(previews, { from: 'preview@myapp.com', layout })
const { url } = await server.listen(3737)
console.log(`Mail preview at ${url}`)
// later: await server.close()
```

## API reference

### `defineMail<T>(definition): MailDefinition<T>`

Creates a typed email definition. `MailDefinition<T>` fields:

| Field | Type | Required? | Description |
|---|---|---|---|
| `name` | `string` | Yes | Unique identifier for the email |
| `schema` | `MailSchema<T>` | No | Schema with `safeParse` (compatible with Zod) to validate the data |
| `subject` | `(data: T) => string` | Yes | Generates the subject |
| `text` | `(data: T) => string` | No | Generates the plain-text body |
| `html` | `(data: T) => string` | No | Generates the HTML body |

### `class Mailer`

`new Mailer(driver: MailDriver, options?: MailerOptions)`

`MailerOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `from` | `string \| (() => string \| undefined)` | No | — | Default sender; the function is evaluated on each send |
| `replyTo` | `string` | No | — | Default reply-to address |

Methods:

| Method | Signature | Description |
|---|---|---|
| `send` | `send(mail, data?, envelope) => Promise<void>` | Validates, renders, and sends (or queues). For emails without data, the second argument is directly the envelope |
| `deliver` | `deliver(message: ResolvedMail) => Promise<void>` | Sends an already-resolved message directly through the driver (used by queue workers) |
| `resolve` | `resolve(mail, data, envelope) => ResolvedMail` | Renders without sending (tests/preview) |
| `useQueue` | `useQueue(dispatch) => this` | Redirects `send()` to a dispatcher (queue) |

### `mailerPlugin(options?: MailerPluginOptions)`

Registers a singleton `Mailer` in the container under the token `MAILER`. `MailerPluginOptions` extends `MailerOptions` with:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `driver` | `'smtp' \| 'log' \| 'memory'` | No | `'log'` | Sending driver |
| `smtp` | `SmtpDriverOptions` | Yes, if `driver: 'smtp'` | — | `{ url: 'smtp(s)://user:pass@host:port' }` |
| `sink` | `(line: string) => void` | No | `console.log` | Destination for the `log` driver's lines |

### Drivers

All implement `MailDriver` (`name`, `send(message)`, `disconnect()`):

| Driver | Use | Notes |
|---|---|---|
| `SmtpMailDriver` | Production | `new SmtpMailDriver({ url })`, sends via nodemailer |
| `LogMailDriver` | Development | `new LogMailDriver(sink?)`, prints the message |
| `MemoryMailDriver` | Testing | `sent: ResolvedMail[]` property and `ofMail(name)` method |

### Other exports

| Export | Type | Description |
|---|---|---|
| `MAILER` | token | Key for the `Mailer` in the container |
| `createMailPreviewServer(previews, opts?)` | function | Browser dev server behind `mail:preview` |
| `definePreview<T>(preview)` | function | Type-checks a preview's sample data against its mail |
| `tenantFrom(fallback?)` | function | Dynamic sender that reads `ctx().tenant.mailFrom` |
| `Envelope` | type | `{ to, from?, cc?, bcc?, replyTo? }` |
| `ResolvedMail` | type | Final message: `{ mail, to[], from, cc[], bcc[], replyTo?, subject, text?, html? }` |
| `MailValidationError` | error | Code `MAIL_INVALID` — data doesn't pass the schema |
| `MailIncompleteError` | error | Code `MAIL_INCOMPLETE` — missing `to` or `from` |
| `MailSchema<T>` | type (Advanced) | Structural schema contract (`safeParse`) |
| `MailDriver` | type (Advanced) | Contract for writing your own driver |

## Common errors and solutions (FAQ)

**"Mail has no sender" (`MAIL_INCOMPLETE`)** — You didn't configure `from` in `mailerPlugin`/`Mailer`, nor pass it in the envelope. Set a default sender.

**"Mail has no recipient" (`MAIL_INCOMPLETE`)** — The envelope's `to` is empty (`[]`) or missing. Pass at least one address.

**`MailValidationError` (`MAIL_INVALID`)** — The data passed to `send()` doesn't match the email's `schema` (e.g. a number where text was expected). The error includes the Zod `issues` pointing to the offending field.

**Emails aren't arriving in development** — You're probably on the `log` driver (the default), which only prints to the console. This is intentional; use `driver: 'smtp'` for real sending.

**I set up `useQueue` and nothing gets sent** — With the queue active, `send()` only delivers to the dispatcher; it's the worker that has to call `mailer.deliver(message)`.

## How it connects to other modules

- **@basaltkit/core** — provides `createApp`, the dependency container where `MAILER` is registered, and the context (`ctx`) used by `tenantFrom`.
- **@basaltkit/notifications** — when the mailer is registered, the notifications plugin automatically creates the `mail` channel, which sends emails through this module (inheriting queueing and per-tenant sender).
- **@basaltkit/queue** — combine with `useQueue` to send emails in the background with retries.
- **@basaltkit/subscriptions** — billing hooks (e.g. `billing:trial_expired`) are a natural place to trigger emails defined here.
