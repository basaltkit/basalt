---
"@basaltkit/tenancy": minor
---

Fail-closed tenant-scoping helpers: `requireTenant()`, `requireTenantId(fallback?)`, `tenantScoped(where?)` and `TenantRequiredError`.

Repositories that derive the tenant from context risk the classic Prisma foot-gun: `where: { tenantId: ctx.tenant?.id }` with no tenant in context silently DROPS the filter and returns every tenant's rows. The helpers make the safe pattern one call:

- `requireTenantId(fallback?)` — the context tenant always wins (anti-widening: caller/client input can never switch the scope), an explicit fallback is honoured when no tenant is in context (system jobs/CLI), and otherwise it THROWS `TenantRequiredError` instead of yielding `undefined`. Same hardened semantics as `Audit.trail()`.
- `tenantScoped(where?)` — spread-ready `{ ...where, tenantId }` for repository where-clauses; `tenantId` is spread last so a smuggled value cannot override the context tenant.
- `requireTenant()` — the whole `Tenant`, same rules.
- `TenantRequiredError` — `TENANT_REQUIRED` with `status = 400`, so every adapter maps it to a client error, never a silent unscoped read.

Strictly opt-in: nothing changes unless a repository author calls the helpers.
