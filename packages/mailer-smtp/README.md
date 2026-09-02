<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/mailer-smtp

**SMTP** driver for [`@basaltkit/mailer`](https://www.npmjs.com/package/@basaltkit/mailer), built on [nodemailer](https://nodemailer.com) — any SMTP server, including Mailpit and MailHog in development.

## What this module solves

`@basaltkit/mailer` defines mails, layouts, previews and queueing over a driver. Most of its drivers are plain HTTP APIs — Resend, SES, Mailgun — and need no client library at all. SMTP is the exception: it needs a real protocol implementation.

It used to live in the core as `driver: 'smtp'`, which meant **every** app installed nodemailer (about **688 KB**), including the ones sending through an HTTP API and never opening an SMTP socket.

## Installation

```bash
pnpm add @basaltkit/mailer @basaltkit/mailer-smtp nodemailer
```

`nodemailer` is a **peer dependency**: you install it explicitly, which keeps it out of everyone else's tree.

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { mailerPlugin, MAILER } from '@basaltkit/mailer'
import { smtpMailer } from '@basaltkit/mailer-smtp'

const app = await createApp({
  plugins: [
    mailerPlugin({
      driver: smtpMailer({ url: process.env.SMTP_URL! }),
      from: 'noreply@myapp.com',
    }),
  ],
}).boot()
```

In development, point it at a local catcher — nothing leaves your machine:

```ts
smtpMailer({ url: 'smtp://localhost:1025' })   // Mailpit, MailHog
```

## API reference

### `smtpMailer(options)` · `new SmtpMailDriver(options)`

| Option | Type | Required? | Description |
|---|---|---|---|
| `url` | `string` | Yes | `smtp://` or `smtps://user:pass@host:port`, as nodemailer accepts it |

The driver maps a resolved mail onto nodemailer's shape, and **omits** what is absent: empty `cc`/`bcc` and missing `text`/`html` are left out rather than sent as empty values, which nodemailer treats differently. `disconnect()` closes the transport, and `mailerPlugin` calls it on shutdown.

## How it connects to other modules

- **`@basaltkit/mailer`** — this is a driver for that package; mail definitions, layouts, previews and queueing all come from there.
- The HTTP-API drivers (`resend`, `ses`, `mailgun`) and the `log`/`memory` ones stay in the core: they need no client library, so they cost you nothing.
- See the [Notifications](https://basaltkit-docs.pages.dev/guide/notifications) guide.
