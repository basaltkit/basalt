---
'@basaltkit/prisma': minor
---

**`migrateTenants` now catches a migration that succeeded without doing anything.**

`prisma migrate deploy` exits 0 when it finds no migrations to apply. A missing
or empty migrations directory therefore looks exactly like success: the tenant is
provisioned, the migrator reports `ok: true`, and the schema comes up holding
`_prisma_migrations` and not one table of its own. The tenant is marked ready and
the damage surfaces much later, as a query against a table that was never created.

After each tenant migrates, `migrateTenants` now counts the tables in that
tenant's schema — ignoring `_prisma_migrations` — and reports `ok: false` when
the count is zero, with `EmptyTenantSchemaError` (`PRISMA_TENANT_SCHEMA_EMPTY`).
Like every other failure it is reported per tenant and never aborts the run.

It runs in schema mode when `provision` can also read the database; a
`PrismaClient` satisfies both, so `provision: admin` is enough. Costs one
`information_schema` query per tenant. Opt out with `verifyTables: false` if a
tenant legitimately starts with no tables.

### Why it counts tables and not migrations

`prisma db push` creates tables straight from `schema.prisma`, with no migration
history at all — a legitimate strategy for disposable tenants. Asking "were
migrations applied?" would report a false failure there. "Does the tenant have
tables?" is the right question under both strategies.

New exports: `countTenantTables(client, schema)`, `canInspect(client)`,
`EmptyTenantSchemaError` and the `SchemaInspector` type.
