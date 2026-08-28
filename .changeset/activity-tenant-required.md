---
"@basaltkit/activity": minor
---

`tenantScoped: 'required'` — opt-in fail-closed query scoping.

`Activity.query()` with the default `tenantScoped: true` auto-scopes when a tenant is in context but runs UNSCOPED when there is none (fail-open). The new `'required'` mode uses `@basaltkit/tenancy`'s `requireTenantId`: the context tenant always wins (a caller-supplied `query.tenantId` cannot widen the scope), an explicit `query.tenantId` is honoured when no tenant is in context, and otherwise the query throws `TenantRequiredError` instead of silently returning every tenant's records. Defaults are unchanged; `@basaltkit/tenancy` is a new (small, core-only) dependency.
