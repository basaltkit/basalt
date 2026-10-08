---
'@basaltkit/generator': minor
---

`--tenant=column|schema|database` (BK-086): `GeneratorOptions.tenant` accepts `'column' | 'schema' | 'database'` besides a boolean (`true` stays `'column'`, output unchanged). For `schema`/`database` the Prisma model has no `tenantId` column and the repository queries the tenant's own `db()` client without a tenant filter, still fail-closed (`requireTenantId()` before every access); the in-memory repository stays partitioned per tenant and the generated test still asserts cross-tenant isolation. The security note states the isolation. The mode is never auto-detected: a detected `@basaltkit/tenancy` dependency still defaults to `column`; set a project default with `generatorCommands({ tenant: 'schema' })` (a bare `--tenant` keeps it). Unknown modes are rejected. New export: `TenantMode` type.
