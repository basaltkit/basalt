---
'@basaltkit/audit': minor
---

BK-083: `auditPlugin` no longer records `auth:apikey_rejected` by default. The hook fires for every request that presents an API key which does not verify, before anyone is authenticated, so under the default `auth:**` pattern any anonymous client could append to the audit trail (and its serialized per-tenant hash chain) at will.

`hooks` now also accepts `{ include, exclude }`. A hook is recorded when it matches `include` and not `exclude`; without `exclude` the new `DEFAULT_AUDIT_HOOK_EXCLUDES` (`['auth:apikey_rejected']`) apply, and a hook named exactly in `include` is always recorded. To keep the previous behaviour, list it: `auditPlugin({ hooks: ['auth:**', 'billing:**', 'tenancy:created', 'permission:**', 'auth:apikey_rejected'] })`.
