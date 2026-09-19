---
'@basaltkit/prisma': minor
---

Row-level security applied automatically, and a boot check for the wrong database.

- `tenancyExtension({ rls: true | { setting } })`: every model operation in tenant scope runs as `$transaction([set_config('app.tenant_id', <tenant>, true), operation])`, so the policies from `rlsPolicySql` filter rows in Postgres too (including an `include` that follows a cross-tenant foreign key). Operations already inside a transaction are not wrapped again.
- `tenantTransaction(client, fn, options?)`: interactive transaction with the tenant set on its own connection first; `tx` stays tenant-scoped.
- The raw-query guard now lets through exactly `$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(<current tenant>))` — the documented RLS wiring used to collide with `PRISMA_RAW_IN_TENANT`. Every other raw query inside a tenant context is still refused.
- `prismaPlugin({ assertMigrated: true | { tables } })` (off by default) fails the boot with `DatabaseNotMigratedError` (`PRISMA_NOT_MIGRATED`) when the shared client's database has no `_prisma_migrations` (or a listed table), naming the database and host it reached — never the credentials. Also exported: `assertMigrated()`, `redactCredentials()`.
