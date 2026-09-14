# @basaltkit/mailer-smtp

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
