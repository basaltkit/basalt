---
'@basaltkit/mailer': major
---

## ⚠️ BREAKING — the SMTP driver moved to `@basaltkit/mailer-smtp`

`@basaltkit/mailer` hard-depended on `nodemailer` — about **688 KB** — because
of the `driver: 'smtp'` shorthand. Every app paid for it, including those sending
through Resend, SES or Mailgun, which are plain HTTP APIs that never open an SMTP
socket.

### Migration

```bash
pnpm add @basaltkit/mailer-smtp nodemailer
```

```diff
+import { smtpMailer } from '@basaltkit/mailer-smtp'

-mailerPlugin({ driver: 'smtp', smtp: { url: process.env.SMTP_URL! }, from })
+mailerPlugin({ driver: smtpMailer({ url: process.env.SMTP_URL! }), from })
```

Passing `'smtp'` now throws with that instruction rather than "unknown driver" —
TypeScript rejects it too, since it left the union.

**Unaffected:** `log`, `memory`, `resend`, `ses` and `mailgun` all stay in the
core. None of them needs a client library.

### `driver` now accepts an instance

```ts
mailerPlugin({ driver: myCustomDriver })
```

Previously `createDriver` was a `switch` over strings with no instance branch, so
**a custom `MailDriver` could not be used at all**. Extracting SMTP required
adding that, and it is useful well beyond this change.

### What this leaves behind

`@basaltkit/mailer` depends on nothing but `@basaltkit/core`. The repo-wide
driver-boundary tripwire's allowlist is now **empty** — this was the last of the
four KNOWN DEBT entries.
