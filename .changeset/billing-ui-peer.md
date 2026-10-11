---
"@basaltkit/billing-ui": major
---

`@basaltkit/subscriptions` becomes a **peer dependency** (`^6`), and `@basaltkit/http` moves to `^3`. The `GET /billing/info` route of `billingUiRoutes()` resolves the app's `SUBSCRIPTIONS` binding from the request container; a token is a module-local symbol, so a second copy of `@basaltkit/subscriptions` (what a plain dependency allowed) could never find it. Install `@basaltkit/subscriptions` 6 in the app (you already have it if you use billing-ui) and upgrade together with `@basaltkit/http` 3. No API change.
