---
'@basaltkit/generator': minor
'@basaltkit/ai': patch
---

Security: `basalt make:resource` (and `make:routes`/`make:repository`/`make:test`) now generates secure-by-default code. Previously the generated CRUD was anonymous and shared across tenants, and `make:resource` auto-wired it into `src/app.ts`.

- Every generated route requires an authenticated user (`meta.auth`, applied to the whole exported routes array). `--public` (alias `--no-auth`) is the explicit opt-out for a deliberately public resource; a single route can opt out with `meta: { auth: false }`.
- When the project depends on `@basaltkit/tenancy` (or with `--tenant`), the resource is tenant-owned: the repository scopes every read and write with `requireTenantId()` (no tenant → `TENANT_REQUIRED`, 400), Prisma by-id writes use `updateMany`/`deleteMany` so another tenant's row is "not found", and the Prisma model gets an indexed `tenantId` column. `--no-tenant` turns it off.
- The generated test authenticates (`actingAs`), asserts anonymous callers get 401 and, when tenant-owned, asserts cross-tenant isolation.
- A security note is printed after generation.
- `@basaltkit/ai`: `basalt ai make` / `basalt_make` inherit authenticated routes, and tenant-scoped entities with an in-memory repository now get the tenant-owned repository.
