---
"@basaltkit/auth-saml": major
---

`@basaltkit/auth` becomes a **peer dependency** (`^5`), and `@basaltkit/http` moves to `^3`. `samlPlugin` resolves the app's `AUTH` binding from the container; a token is a module-local symbol, so a second copy of `@basaltkit/auth` (what a plain dependency allowed when the app sat on another major) fails the boot with a missing binding. Install `@basaltkit/auth` 5 in the app (you already have it) and upgrade together with `@basaltkit/http` 3. No API change.
