---
"@machize/prisma": minor
---

Add per-tenant migration orchestration and the `mach tenant:migrate` command.
`migrateTenants` runs migrations for every tenant with bounded concurrency,
provisions the schema first in schema-per-tenant mode, and returns a per-tenant
report where one failure never aborts the rest. `tenantMigrateCommand` wraps it
as a CLI command (registered via commandsPlugin); `prismaMigrator` is the default
migrator (shells out to `prisma migrate deploy` with each tenant's scoped URL,
overridable). Adds `@machize/cli` as a dependency.
