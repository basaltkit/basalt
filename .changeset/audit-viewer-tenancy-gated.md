---
'@basaltkit/audit-viewer': minor
---

The viewer works in apps without tenancy.

`AuditViewer.page()`, `stats()` and `get()` all resolved a tenant through a `tenant()` helper that threw `AuditTenantRequiredError` (`400 AUDIT_TENANT_REQUIRED`) whenever none could be found — so in an app with no `tenancyPlugin` every read, and every mounted `/audit*` route, returned 400 forever.

`auditViewerPlugin` now reads tenancy's `tenancy:active` metadata marker (a signal, not an import — no dependency on `@basaltkit/tenancy`) and only fails closed when tenancy is actually registered. Without it, reads are unscoped, which is correct: there is no tenant dimension to cross. With it, behavior is unchanged. `new AuditViewer(audit, options, tenancyActive?)` takes an optional third argument.
