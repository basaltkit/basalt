---
'@basaltkit/prisma': minor
---

**Fail loud when schema-per-tenant is configured against a database that cannot
do it.**

Schema-per-tenant is a PostgreSQL feature: it relies on a schema being a
namespace *inside* a database, selected by the connection's `search_path`. In
MySQL a "schema" **is** a database; SQLite has no equivalent. Until now,
configuring it against either surfaced as a raw `CREATE SCHEMA` syntax error
from the driver — at tenant-creation time, far from the configuration that
caused it.

Now it is refused where the configuration is read:

- **at boot**, when `prismaPlugin({ schemaPerTenant })` is given a non-PostgreSQL
  URL;
- **before any migration runs**, in `migrateTenants({ target: { mode: 'schema' } })`.

The message names the alternative — database-per-tenant, via `forTenant` or
`{ mode: 'database', urlFor }` — which gives stronger isolation anyway.

New exports: `providerOf(url)`, `assertSchemaPerTenantSupported(url)`,
`SchemaPerTenantUnsupportedError` (`PRISMA_SCHEMA_PER_TENANT_UNSUPPORTED`) and
the `DatabaseProvider` type.

### Deliberately not a capability layer

This is a guard, not an abstraction. Translating `mode: 'schema'` into a separate
database on MySQL would be doing database-per-tenant under a name that says
otherwise — different backups, different connection limits, different migration
cost — and that belongs in your config as a decision, not in the framework as a
silent substitution.

An **unknown** URL scheme is allowed through: `prisma://` and custom poolers
cannot be classified, and refusing them on a guess would block valid setups.

`migrateTenants` normally reports a failing tenant and carries on. This check is
the one exception, and intentionally so: in schema mode every tenant shares the
base URL, so an unsupported database is a configuration error for the whole run.
Collecting N identical failures would bury the cause.
