---
"@basaltkit/testing": major
---

`@basaltkit/mailer` becomes a **peer dependency** (`^2.1.0`, the range the previous dependency already had). `fakeMailer()` binds `MAILER` for the app under test; from a private copy of `@basaltkit/mailer` that binding is invisible to the app's `@basaltkit/notifications` and `Mailer` users, so a test would assert on a fake nothing writes to. Install `@basaltkit/mailer` next to `@basaltkit/testing` (a `create-basalt` app already has it when it sends mail). No API change.
