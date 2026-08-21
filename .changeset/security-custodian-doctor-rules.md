---
"@basaltkit/ai": minor
---

`ai:doctor` gains two security-invariant rules — the continuous custodian for the tenant-isolation fixes:

- **`missing-tenant-membership`** (error) — fires when an app wires tenancy + auth + teams but no `tenantMembershipPlugin`, statically catching the cross-tenant-access class (a resolved tenant that's never bound to a verified member).
- **`missing-security-plugin`** (warning) — fires when no `securityPlugin()` is registered, so responses would ship without secure headers.

Run `basalt ai:doctor` in CI to fail the build on a security regression. Also adds `AppFileInfo.pluginCalls` (every `<name>Plugin(` call detected in the app file) to the project context.
