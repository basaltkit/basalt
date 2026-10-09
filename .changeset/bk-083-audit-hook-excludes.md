---
'@basaltkit/audit': minor
'@basaltkit/auth': minor
---

BK-083: `auditPlugin` no longer records `auth:apikey_rejected` by default. The hook fires for every request that presents an API key which does not verify, before anyone is authenticated, so under the default `auth:**` pattern any anonymous client could append to the audit trail (and its serialized per-tenant hash chain) at will.

Refusals of a key that DID verify (`tenant_mismatch`, `not_allowed`, `scope`) are still audited by default: `apiKeysPlugin` (`@basaltkit/auth`) now emits them a second time as the new `auth:apikey_refused` hook (`{ id, reason, tenantId? }`), right after `auth:apikey_rejected`, and `auth:**` records it. Only an unknown/revoked/expired key (`reason: 'invalid'`) — the anonymous, unattributable noise — leaves the default capture. Listeners of `auth:apikey_rejected` see every refusal exactly as before.

`hooks` now also accepts `{ include, exclude }`. A hook is recorded when it matches `include` and not `exclude`; without `exclude` the new `DEFAULT_AUDIT_HOOK_EXCLUDES` (`['auth:apikey_rejected']`) apply, and a hook named exactly in `include` is always recorded. A custom `hooks` list applies the excludes too (a wildcard does not re-include them). To keep the previous behaviour, list it: `auditPlugin({ hooks: ['auth:**', 'billing:**', 'tenancy:created', 'permission:**', 'auth:apikey_rejected'] })` — a valid-key refusal is then recorded twice, under both names. For a bounded signal on invalid-key bursts instead, see the throttled listener in the persistence guide ("Which hooks are audited").
