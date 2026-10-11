---
"@basaltkit/audit-viewer": minor
---

`@basaltkit/audit` becomes a **peer dependency** (`^3.0.0`: the viewer needs nothing from 3.2, so an app on audit 3.0 or 3.1 keeps it), like `@basaltkit/audit-prisma` and `@basaltkit/audit-sqlite`, and the same way `billing-ui` and `auth-saml` take `@basaltkit/subscriptions` / `@basaltkit/auth`. `auditViewerPlugin` reads the app's `AUDIT` binding from the container; a token is a module-local symbol, so a second copy of `@basaltkit/audit` (what a plain dependency allows once the app sits on another line) would fail the boot with a missing binding. No API change, and the audit line does not move: an app that uses the viewer already installs `@basaltkit/audit` to register `auditPlugin`.

The `@basaltkit/http` dependency moves from `^2.7.0` to `^3.0.0`. It stays a private copy (the viewer only builds routes and escapes HTML with it), so its routes run on either http line; upgrade it with the set, see the [release notes](https://basaltkit-docs.pages.dev/guide/whats-new#upgrading-since-1-13).
