---
"@basaltkit/audit-viewer": minor
---

`@basaltkit/audit` becomes a **peer dependency** (`^3`), like `@basaltkit/audit-prisma` and `@basaltkit/audit-sqlite`, and the same way `billing-ui` and `auth-saml` take `@basaltkit/subscriptions` / `@basaltkit/auth`. `auditViewerPlugin` reads the app's `AUDIT` binding from the container; a token is a module-local symbol, so a second copy of `@basaltkit/audit` (what a plain dependency allows once the app sits on another line) would fail the boot with a missing binding. No API change, and the audit line does not move: an app that uses the viewer already installs `@basaltkit/audit` to register `auditPlugin`.
