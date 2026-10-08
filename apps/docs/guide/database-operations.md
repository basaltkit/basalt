# Database operations

A SaaS with a schema (or a database) per tenant has **two migration planes**:
the central database and every tenant's. Prisma Migrate runs each of them;
Basalt adds what Prisma does not say — what a failure means, and where each
plane stands — and leaves the rest to plain `prisma` commands.

This page covers the errors you meet on a bad morning, a read-only
`db:status` for CI, and an idempotent recipe for the grants and extensions that
migrations cannot keep in place.

## What the errors mean

`describeDbError(error)` from `@basaltkit/prisma` maps a database failure to a
cause and a one-line fix. `assertMigrated` (and so
`prismaPlugin({ assertMigrated: true })`), `tenant:migrate` and `db:status`
use it, and the scaffolded `bin/basalt.ts` and `src/server.ts` print its fix
instead of a bare stack trace.

| Code | You see | It means | Fix |
| --- | --- | --- | --- |
| `DB_PERMISSION_DENIED` | `permission denied for schema public` (SQLSTATE `42501`, also inside Prisma `P2010`), `P1010` | The app's role lacks a privilege — typically lost when `public` was dropped and recreated (a reset, a partial restore). The migration that granted it is already recorded, so nothing re-applies it | `GRANT USAGE ON SCHEMA public TO <role>;` — the role is taken from the URL or the connection. Then make the grants a [post-deploy step](#grants-and-extensions-are-state-not-history) |
| `DB_NOT_EMPTY_BASELINE` | `P3005 The database schema is not empty` | `migrate deploy` refuses a database that has tables but no migration history | Baseline: `prisma migrate resolve --applied <migration>` for each migration already reflected in the schema, then `prisma migrate deploy` |
| `DB_UNREACHABLE` | `P1001`, `ECONNREFUSED`, `ENOTFOUND`, `P1000`, `P1003` | The server is down or the URL is wrong (host, port, credentials, database name) | Check `DATABASE_URL`, start the database |
| `DB_NOT_MIGRATED` | `P2021`, `relation "…" does not exist` | The tables are not there: never migrated, or the wrong database | `prisma migrate deploy` (central), `pnpm basalt tenant:migrate` (tenants) |

```ts
import { describeDbError } from '@basaltkit/prisma'

try {
  await db.project.findMany()
} catch (error) {
  const diagnosis = describeDbError(error, { url: process.env.DATABASE_URL })
  if (diagnosis) logger.error(`${diagnosis.cause} Fix: ${diagnosis.fix}`)
  throw error
}
```

It returns `undefined` for anything else (a unique-constraint error is not an
operations problem), and redacts credentials from every message it quotes.

On PostgreSQL, a role **without USAGE on a schema does not get "permission
denied"** for an unqualified table name — the schema just drops out of the
`search_path`, and the table "does not exist". `assertMigrated` checks the
catalog for that case, so a revoked grant is reported as `DB_PERMISSION_DENIED`
with the `GRANT`, not as a database to migrate. The error keeps its code
`PRISMA_NOT_MIGRATED`; `error.details.diagnosis` carries `{ code, cause, fix }`.

## `db:status` — where every plane stands

`dbStatusCommand()` builds a **read-only** `basalt db:status`: it runs
`prisma migrate status` for the central plane and for every tenant, prints one
line per plane with the fix for whatever is wrong, and **exits 1** when anything
is pending, failed, drifted or unreachable.

```ts
import { commandsPlugin } from '@basaltkit/cli'
import { dbStatusCommand, tenantMigrateCommand } from '@basaltkit/prisma'

const target = { mode: 'schema', url: process.env.DATABASE_URL! } as const
const tenantIds = async () => (await tenants.list()).map((tenant) => tenant.id)

commandsPlugin([
  tenantMigrateCommand({ tenants: tenantIds, target }),
  dbStatusCommand({
    central: { configPath: 'prisma.config.ts' },
    tenants: { list: tenantIds, target, configPath: 'prisma/tenant/prisma.config.ts' },
  }),
])
```

```sh
$ pnpm basalt db:status
ok   central: up to date
ok   tenant acme (tenant_acme): up to date
FAIL tenant globex (tenant_globex): 2 pending — 20260901_invoices, 20260915_tags
       fix: Run the migrations for this plane.
Not up to date. Tenants: 1 up to date, 1 not.
```

`--json` prints `{ ok, planes: [{ plane, tenantId?, schema?, state, pending?, detail?, fix? }] }`.
Run it in CI after the deploy step — or before, to refuse a deploy onto a drifted
database. It never applies, provisions, baselines or grants anything.

## Grants and extensions are state, not history

A migration runs once. Anything that recreates `public` — a reset, a partial
restore, a hand-run `DROP SCHEMA` — takes the app role's grants and the
extensions with it, and the migration that created them is already recorded as
applied. A second migration has the same weakness the moment it is recorded.

Keep them in an **idempotent SQL file** run on every deploy, after
`prisma migrate deploy`, as the database owner:

```sql
-- prisma/post-deploy.sql — safe to run any number of times
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;

-- what the runtime role must NOT have, stated just as explicitly
REVOKE UPDATE, DELETE ON audit_log FROM app_runtime;
```

```sh
prisma migrate deploy
psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -f prisma/post-deploy.sql
pnpm basalt tenant:migrate
pnpm basalt db:status
```

Basalt deliberately does not ship a DSL for this: the grant topology (which
roles, which tables, what is revoked) is deployment policy, and SQL already
states it exactly.

## Baselines and new migrations stay plain Prisma

There is no `db:baseline` or `db:new` wrapper. Prisma's own commands do it, and a
wrapper would only hide them:

- **New migration**: `prisma migrate dev --name <name>` (central), or with the
  tenant plane's `--config` (see [Database-per-tenant](/guide/database-per-tenant#where-the-tenant-migrations-live)).
- **Baseline an existing database**: `prisma migrate resolve --applied <migration>`
  per migration already present, then `prisma migrate deploy`.

See also: [Multi-tenant pattern](/guide/multi-tenant-pattern) for one schema and
one config per plane, and [Production](/guide/production) for the boot checks.
