---
"@basaltkit/mailer": minor
---

**Security (S-6): the log mail driver redacts message bodies in production, and an unknown driver name fails loud.** The silent default driver (`driver` unset) printed the FULL mail body — password-reset links, magic links, tokens — to stdout, where log aggregators retain it; and any typo'd `driver` string silently fell through to that same behavior. Now: `LogMailDriver` logs metadata (mail name, recipients, subject) but redacts the body when `NODE_ENV=production` — opt back in explicitly with the new `logBody: true` option (dev/test behavior is unchanged: bodies still print, which is what makes the driver useful locally). An unrecognized `driver` value throws at mailer resolution with the list of valid drivers instead of silently logging your outbound mail.
