---
'@basaltkit/mailer': minor
'@basaltkit/queue': patch
'@basaltkit/env': patch
---

One `NODE_ENV` policy across packages (framework audit FA-013): an unset `NODE_ENV` counts as production everywhere, as `@basaltkit/env` already documented.

- `@basaltkit/mailer`: `LogMailDriver`'s `logBody` default is now `true` only with an explicit `NODE_ENV=development` or `test`. Previously an unset `NODE_ENV` logged full mail bodies (password-reset links, magic links, tokens). Minor rather than patch because the default output changes: a local setup without `NODE_ENV` now sees `(body redacted in production — …)` — set `NODE_ENV=development` or pass `logBody: true`.
- `@basaltkit/queue`: the boot warning for an implicitly selected sync driver now also fires when `NODE_ENV` is unset.
- `@basaltkit/env`: `secret()` now uses the shared `isProductionEnvironment()` from `@basaltkit/core` (no behaviour change).
