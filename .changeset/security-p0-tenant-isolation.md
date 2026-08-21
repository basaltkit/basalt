---
"@basaltkit/prisma": minor
"@basaltkit/teams": minor
"create-basalt": patch
---

Tenant isolation hardening (security P0). Closes the multi-tenant gaps found in the deep security audit:

- **`tenantMembershipPlugin`** (`@basaltkit/teams`) — secure-by-default guard that binds the authenticated user to the resolved tenant on every request, returning 403 when the caller is not a member. Central routes opt out with `meta: { central: true }`. Tenant resolution is identification, never authorization.
- **Raw-query guard** (`@basaltkit/prisma`) — `tenancyExtension` now refuses `$queryRaw`/`$queryRawUnsafe`/`$executeRaw`/`$executeRawUnsafe` while a tenant is in scope (`PRISMA_RAW_IN_TENANT`), so raw SQL can't silently bypass tenant scoping. Opt out per case with `onRawInTenant: 'allow'`.
- **Postgres RLS helpers** (`@basaltkit/prisma`) — `rlsPolicySql`, `setTenantConfigSql`, `tenantConfigParams` add a database-enforced isolation layer (verified against real Postgres: a query with no tenant predicate still only sees the active tenant, and fails closed when unset).
- **Fail-closed scaffold secret** (`create-basalt`) — generated apps now use `secret({ minLength: 32 })` for `APP_SECRET` (required in production, no committed default) instead of a placeholder that reached production.
