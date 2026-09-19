# @basaltkit/mailer-smtp

## 1.0.2

### Patch Changes

- fb85c40: Security hardening for the Express and Hono adapters.
  
  - `@basaltkit/hono`: `request.ip` is now populated from the socket address (`@hono/node-server`, Bun) or a new `getClientIp` option, so per-client rate limiting and the IP login throttle work; a one-time warning is printed when no IP can be resolved.
  - `@basaltkit/hono`: `bodyLimit` is now enforced on the bytes actually read, including chunked/streamed bodies without `Content-Length`.
  - `@basaltkit/hono`: error responses keep the security and CORS headers set by pre-hooks; the 413 body now uses the standard `{ error: { code, message } }` envelope (was a flat `{ code, message }`).
  - `@basaltkit/express`: a final error middleware (opt out with `errorHandler: false`) answers body-parser and pre-hook errors with the neutral JSON envelope instead of an HTML stack trace; async pre-hook and edge-route errors are forwarded on Express 4.
  - Peer floors raised to versions without known advisories: `express ^4.22.3 || ^5.2.1`, `hono ^4.13.5`, `nodemailer ^9.1.1 || ^10.0.0`.

## 1.0.1

### Patch Changes

- ef632fc: Accept both nodemailer 9 and 10 as the peer dependency (`^9.0.0 || ^10.0.0`). The development dependency moved to nodemailer 10; applications still on nodemailer 9 keep a valid peer range instead of getting an unmet-peer warning on upgrade.

## 1.0.0

### Major Changes

- 48579dd: **New package: the SMTP driver for `@basaltkit/mailer`**, extracted from the core
  so apps on Resend, SES or Mailgun stop installing nodemailer.
  
  ```bash
  pnpm add @basaltkit/mailer-smtp nodemailer
  ```
  
  ```ts
  import { smtpMailer } from '@basaltkit/mailer-smtp'
  
  mailerPlugin({ driver: smtpMailer({ url: process.env.SMTP_URL! }), from: 'noreply@app.com' })
  ```
  
  Exports `smtpMailer(options)` and `SmtpMailDriver`. `nodemailer` is a peer
  dependency.
  
  The driver code is unchanged from `@basaltkit/mailer`, but it now has tests: it
  had none there, the only one of the four extracted drivers in that state. They
  pin the mapping onto nodemailer's shape — in particular that empty `cc`/`bcc` and
  absent `text`/`html` are **omitted** rather than sent as empty values, which
  nodemailer treats differently.

### Patch Changes

- Updated dependencies [48579dd]
  - @basaltkit/mailer@2.0.0
