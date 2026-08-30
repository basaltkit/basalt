---
'@basaltkit/files': minor
---

Files works in apps without tenancy.

Every operation — `upload`, `get`, `list`, `download`, `temporaryUrl`, `delete`, `markScanned` — resolved a tenant and threw `FileTenantRequiredError` (`400 FILE_TENANT_REQUIRED`) when it couldn't. In an app with no `tenancyPlugin` that is always, making the package unusable outside multi-tenant SaaS.

`filesPlugin` now reads tenancy's `tenancy:active` metadata marker (a signal, not an import) and fails closed only when tenancy is registered — unchanged for multi-tenant apps. Without tenancy, records are filed under the exported `SINGLE_TENANT_SCOPE` (`'default'`) and storage operations are **not** wrapped in a synthesized tenant context, so disk paths stay unprefixed and identical to using `@basaltkit/storage` directly. `new Files(options, tenancyActive?)` takes an optional second argument.
