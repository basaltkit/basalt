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
import { defineMail, html } from '@basaltkit/mailer'
import { z } from 'zod'

export const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Welcome, ${name}!`,
  text: ({ name }) => `Hello ${name}`,
  // Use the html tagged template for HTML bodies: every interpolation is
  // HTML-escaped, so user data can't inject markup into mail sent from your
  // own domain. (Plain template strings are NOT escaped.)
  html: ({ name }) => html`<h1>Hello ${name}</h1>`,
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

> **SMTP lives in its own package.** `pnpm add @basaltkit/mailer-smtp nodemailer`, then
> `import { smtpMailer } from '@basaltkit/mailer-smtp'`. It left the core so apps sending
> through Resend, SES or Mailgun — plain HTTP APIs — stop installing nodemailer.

```ts
// SMTP (any mail server)
mailerPlugin({ driver: smtpMailer({ url: 'smtps://user:password@smtp.example.com:465' }), from: 'noreply@myapp.com' })

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

### Safe HTML bodies — `html`, `raw`, `escapeHtml`

Mail bodies are HTML rendered from data that is usually **user-controlled**:
names, project titles, comment text. Interpolating that into a plain template
literal hands an attacker markup inside mail sent from *your* DKIM/SPF-aligned
domain — phishing content, tracking pixels, XSS in permissive webmail clients.

The safe path is the default path. Write bodies with the `html` tagged template
literal and every interpolation is escaped for you; forgetting is not possible:

```ts
import { html, raw, escapeHtml, defineMail } from '@basaltkit/mailer'

defineMail({
  name: 'comment',
  subject: () => 'New comment',
  //  <script> in `body` arrives as visible text, not as markup
  html: ({ author, body }) => html`<p><b>${author}</b> wrote: ${body}</p>`,
})
```

| Export | Signature | What it does |
|---|---|---|
| `html` | tagged template → `SafeHtml` | Escapes **every** interpolation. Arrays render item-by-item, `null`/`undefined` render as empty, and a nested `SafeHtml` passes through verbatim so templates compose without double-escaping. |
| `raw` | `raw(value: string): SafeHtml` | Marks a string as already-trusted so `html` interpolates it **verbatim**. |
| `escapeHtml` | `escapeHtml(value: string): string` | Escapes `& < > " '` as numeric entities. For hand-composing markup outside a tagged template. |
| `SafeHtml` | `class` | A fragment of safe HTML. `toString()` returns the markup, so it drops straight into a mail's `html` field — `MailDefinition.html` returns `string \| SafeHtml`. |

**`raw` reintroduces exactly the injection risk `html` removes.** It is the one
escape hatch, and it is unconditional: whatever you pass is emitted as markup.
Only use it on fragments **you** built — a rendered MJML document, a layout
partial, a nested `html` result. Never on schema data, database rows, or
anything that reached you over the network:

```ts
html`<div>${raw(renderedMjml)}</div>`     // fine — you produced renderedMjml
html`<div>${raw(comment.body)}</div>`     // an injection hole, don't
```

A plain, untagged template literal is **not** escaped — it compiles, it sends,
and it is exactly the vector above. Reach for the `html` tag every time:

```ts
html: ({ name }) => `<h1>Hello ${name}</h1>`        // unescaped — avoid
html: ({ name }) => html`<h1>Hello ${name}</h1>`    // escaped
```

### Layouts & templates

`defineMail`'s `html(data)` returns a string, so **any template engine works** —
plain template literals, [MJML](https://mjml.io) (`mjml2html(...)`), or
[React Email](https://react.email) (`render(<Email/>)`). Render inside `html()`.

For shared branding (header/footer, per-tenant colours), pass a `layout` — it
wraps every mail's HTML body once:

```ts
mailerPlugin({
  driver: smtpMailer({ url: process.env.SMTP_URL! }),
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

mailerPlugin({ driver: smtpMailer({ url: process.env.SMTP_URL! }), from: tenantFrom('fallback@myapp.com') })
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
  driver: smtpMailer({ url: process.env.SMTP_URL! }),
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
| `html` | `(data: T) => string \| SafeHtml` | No | Generates the HTML body. Return the `SafeHtml` from the `html` tagged template (see *Safe HTML bodies* above). |

### `class Mailer`

`new Mailer(driver: MailDriver, options?: MailerOptions)`

`MailerOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `from` | `string \| (() => string \| undefined)` | — | Default sender. A function is resolved on **every** send — that's how `tenantFrom()` gives each tenant its own sender. |
| `replyTo` | `string` | — | Default reply-to, overridable per envelope. |
| `layout` | `(html: string, context: { mail: string; data: unknown }) => string` | — | Wraps every rendered HTML body in shared branding. Runs per send, so it can read `ctx().tenant`. Applied only when the mail has an HTML body. |

Methods:

| Method | Signature | Description |
|---|---|---|
| `send` | `send(mail, data?, envelope) => Promise<void>` | Validates, renders, and sends (or queues). For emails without data, the second argument is directly the envelope |
| `deliver` | `deliver(message: ResolvedMail) => Promise<void>` | Sends an already-resolved message directly through the driver (used by queue workers) |
| `resolve` | `resolve(mail, data, envelope) => ResolvedMail` | Renders without sending (tests/preview) |
| `useQueue` | `useQueue(dispatch) => this` | Redirects `send()` to a dispatcher (queue) |

### `mailerPlugin(options?: MailerPluginOptions)`

Registers a singleton `Mailer` in the container under the token `MAILER`, and
disconnects the driver on shutdown. `MailerPluginOptions` extends `MailerOptions`
(`from`, `replyTo`, `layout` — see above) with:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `driver` | `'smtp' \| 'log' \| 'memory' \| 'resend' \| 'ses' \| 'mailgun'` | `'log'` | Which driver sends. An **unrecognized** name throws at first resolve instead of falling back to `log` — a silent fallback would print every outbound mail, reset links included, to stdout. |
| `resend` | `ResendDriverOptions` | — | Required with `driver: 'resend'`. `{ apiKey, baseUrl?, fetch? }`. |
| `ses` | `SesDriverOptions` | — | Required with `driver: 'ses'`. `{ region, accessKeyId, secretAccessKey, sessionToken?, endpoint?, fetch?, now? }`. |
| `mailgun` | `MailgunDriverOptions` | — | Required with `driver: 'mailgun'`. `{ apiKey, domain, region?, baseUrl?, fetch? }`; `region` defaults to `'us'`. |
| `sink` | `(line: string) => void` | `console.log` | Where the `log` driver writes its lines. |
| `logBody` | `boolean` | `true` outside production, `false` when `NODE_ENV === 'production'` | `log` driver only — whether the message body is written to the log. See below. |
| `previews` | `MailPreview[]` | — | Mails exposed by the `basalt mail:preview` command. Declaring any registers the command; declaring none leaves it unregistered. |

#### `logBody` — what gets redacted

The `log` driver is what you get with no `driver` at all, so a deploy that
forgot to configure mail would otherwise stream password-reset links, magic
links and tokens straight into a log aggregator, where they are retained and
broadly readable. So in production the body is withheld by default.

The **envelope line is always logged**, in both modes:

```
[mail] welcome → ada@example.com | Welcome, Ada!
```

That is the mail name, the `to` list, and the subject. What `logBody` controls
is only the line beneath it — the body:

| `logBody` | Body line |
|---|---|
| `true` (default outside production) | `message.text`, falling back to `message.html`, falling back to `(empty body)` |
| `false` (default in production) | `(body redacted in production — pass 'logBody: true' to log it, or configure a real driver)` |

Set `logBody: true` to opt back in deliberately; set `logBody: false` in
development to stop bodies reaching your terminal. Note it redacts the *body
only* — recipients and subjects are still logged, so treat mail logs as
containing personal data either way.

### Drivers

All implement `MailDriver` (`name`, `send(message)`, `disconnect()`):

| Driver | Use | Notes |
|---|---|---|
| `SmtpMailDriver` | Production | `new SmtpMailDriver({ url })` — sends via nodemailer. Works with SES SMTP credentials too. |
| `ResendMailDriver` | Production | `new ResendMailDriver({ apiKey, baseUrl?, fetch? })` — Resend HTTP API, no SDK. |
| `SesMailDriver` | Production | `new SesMailDriver({ region, accessKeyId, secretAccessKey, … })` — SES v2 over HTTPS with a hand-rolled SigV4 signature (`node:crypto` only, no AWS SDK). |
| `MailgunMailDriver` | Production | `new MailgunMailDriver({ apiKey, domain, region? })` — Mailgun HTTP API, Basic auth, form-encoded body. |
| `LogMailDriver` | Development | `new LogMailDriver(sink?, { logBody? })` — prints the envelope; the body honours `logBody`. |
| `MemoryMailDriver` | Testing | `sent: ResolvedMail[]` property and `ofMail(name)` method. |

Every driver receives the message **after** the shared header-injection guard,
so a driver never has to re-validate the envelope.

### Other exports

| Export | Type | Description |
|---|---|---|
| `MAILER` | token | Key for the `Mailer` in the container |
| `createMailPreviewServer(previews, opts?)` | function | Browser dev server behind `mail:preview` |
| `definePreview<T>(preview)` | function | Type-checks a preview's sample data against its mail |
| `tenantFrom(fallback?)` | function | Dynamic sender that reads `ctx().tenant.mailFrom` |
| `Envelope` | type | `{ to, from?, cc?, bcc?, replyTo? }` |
| `ResolvedMail` | type | Final message: `{ mail, to[], from, cc[], bcc[], replyTo?, subject, text?, html? }` |
| `html` / `raw` / `escapeHtml` / `SafeHtml` | HTML safety | Escaping tagged template, its trusted-fragment escape hatch, and the manual escaper |
| `assertHeaderSafe(message)` | function | The header-injection choke point, exported for custom send paths |
| `renderPreviewResponse(previews, mailer, pathname, query?)` | function | Pure preview router — assertable without a socket |
| `MailPreview`, `MailPreviewOptions`, `MailPreviewServer`, `PreviewResponse` | types | Preview server types |
| `MailSchema<T>` | type (Advanced) | Structural schema contract (`safeParse`) |
| `MailDriver` | type (Advanced) | Contract for writing your own driver |

### Failure modes & troubleshooting

| Error | Code | HTTP | When |
|---|---|---|---|
| `MailValidationError` | `MAIL_INVALID` | 500 | The data passed to `send()` fails the mail's `schema`. Carries `mail` and the raw `issues`. |
| `MailIncompleteError` | `MAIL_INCOMPLETE` | 500 | The envelope has no `to`, or no `from` and no configured default. |
| `MailHeaderInjectionError` | `MAIL_HEADER_INJECTION` | 400 | A CR/LF in the subject, or a malformed/control-character-bearing address in `from`/`to`/`cc`/`bcc`/`replyTo`. Carries `field` and `value`. |
| `MailDeliveryError` | `MAIL_DELIVERY_FAILED` | 500 | An API driver (Resend, SES, Mailgun) got a non-success response. Carries `driver`, `httpStatus` and `detail`. |

Only `MailHeaderInjectionError` declares a `status`, so it reaches the client as
a 400 with its code; the others have none and surface as a generic 500
`INTERNAL_ERROR` through the adapters. Catch and map them if a caller needs to
tell them apart.

The header guard is a single choke point in `resolve()` — and `deliver()`
re-runs it, so a message that round-tripped through a queue is re-checked before
it reaches the driver. Address validation is deliberately conservative rather
than a full RFC 5322 parser: no control characters, exactly one non-leading,
non-trailing `@`, no whitespace in the addr-spec. `"Alice" <alice@example.com>`
is accepted.

- **`MAIL_HEADER_INJECTION` on a legitimate address** — the addr-spec check is
  strict. Strip the newline your template appended, or use the
  `"Name" <addr@host>` form rather than free-form text.
- **Mail silently not sending after `useQueue`** — `send()` only hands off to
  the dispatcher; the worker must call `mailer.deliver(message)`.
- **`Unknown mail driver "…"`** — a typo in `driver`. This throws on purpose;
  falling back to `log` would print your outbound mail.

## Common errors and solutions (FAQ)

**"Mail has no sender" (`MAIL_INCOMPLETE`)** — You didn't configure `from` in `mailerPlugin`/`Mailer`, nor pass it in the envelope. Set a default sender.

**"Mail has no recipient" (`MAIL_INCOMPLETE`)** — The envelope's `to` is empty (`[]`) or missing. Pass at least one address.

**`MailValidationError` (`MAIL_INVALID`)** — The data passed to `send()` doesn't match the email's `schema` (e.g. a number where text was expected). The error includes the Zod `issues` pointing to the offending field.

**Emails aren't arriving in development** — You're probably on the `log` driver (the default), which only prints to the console. This is intentional; use `smtpMailer()` from `@basaltkit/mailer-smtp` for real sending.

**I set up `useQueue` and nothing gets sent** — With the queue active, `send()` only delivers to the dispatcher; it's the worker that has to call `mailer.deliver(message)`.

## Hooks & events

`@basaltkit/mailer` emits **no hooks** — it is a send-side service. Wire it to
events emitted elsewhere (`team:invited` from `@basaltkit/teams`,
`billing:*` from `@basaltkit/subscriptions`), or let
`@basaltkit/notifications` drive it through its `mail` channel.

## How it connects to other modules

- **@basaltkit/core** — provides `createApp`, the dependency container where `MAILER` is registered, and the context (`ctx`) used by `tenantFrom`.
- **@basaltkit/notifications** — when the mailer is registered, the notifications plugin automatically creates the `mail` channel, which sends emails through this module (inheriting queueing and per-tenant sender).
- **@basaltkit/queue** — combine with `useQueue` to send emails in the background with retries.
- **@basaltkit/subscriptions** — billing hooks (e.g. `billing:trial_expired`) are a natural place to trigger emails defined here.

Guides: [Notifications](/guide/notifications) · [Queues](/guide/queues) · [Security](/guide/security).
