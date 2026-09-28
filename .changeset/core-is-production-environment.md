---
'@basaltkit/core': minor
---

New `isProductionEnvironment(nodeEnv?)` — the single, fail-closed `NODE_ENV` policy shared by every Basalt package (framework audit FA-013). Only an explicit `NODE_ENV=development` or `test` is non-production; unset, empty, `staging` or a typo count as production (also on a runtime without `process`). `@basaltkit/env`, `@basaltkit/auth`, `@basaltkit/mailer` and `@basaltkit/queue` now all use it, so they can no longer disagree about what an unset `NODE_ENV` means.
