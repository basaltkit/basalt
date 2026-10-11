---
"@basaltkit/notifications": major
---

`@basaltkit/mailer` becomes a **peer dependency** (`^1`). `notificationsPlugin` wires the `mail` channel only when `container.has(MAILER)`; a token is a module-local symbol, so with a private copy of `@basaltkit/mailer` (what a plain dependency allows once the app sits on another mailer line) that check is false and email is silently never sent. Install `@basaltkit/mailer` in the app (`pnpm add @basaltkit/mailer`); an app that sends mail already has it for `mailerPlugin`. No API change.
