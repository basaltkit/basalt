---
'@basaltkit/permissions': major
---

Security hardening (B04):

- `GLOBAL_SCOPE` is now `'@global'` (was `'global'`), a value no tenant id can take, so a tenant named after the global scope can no longer hold platform-wide grants. The Gate refuses (`ReservedScopeError`, `PERMISSION_SCOPE_RESERVED`, 403) to evaluate a request whose tenant id is `'@global'` or `'global'`; `isReservedScope(id)` lets tenant registries refuse those ids. **Migration:** rewrite stored rows with `scope = 'global'` to `'@global'`, or set `readLegacyGlobalScope: true` temporarily (reserve the `'global'` tenant id first). `MemoryAccessStore` keys can no longer be forged by ids containing its separator. A context that carries a tenant without a non-empty string id also gets `ReservedScopeError` instead of silently falling back to the global scope.
- Audience confinement now also sees roles held in the global scope: it confines on the current tenant's roles, or on the global ones when the tenant grants none (`gate.audienceRoles()`), so a globally-assigned confined role confines inside tenants and an unnamed global baseline role does not un-confine a tenant's client. `gate.effectiveRoles()` returns the full union `can()` consults.
- The Gate emits `permission:denied`, `permission:role_assigned`, `permission:role_removed`, `permission:granted` and `permission:delegated` hooks (captured by `auditPlugin` by default); new `gate.assignRole/removeRole/grantToRole/grantToUser` write through the store and emit them.
