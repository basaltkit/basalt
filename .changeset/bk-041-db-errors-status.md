---
"@basaltkit/prisma": minor
---

Readable database failures and a read-only `db:status` (BK-041).

- `describeDbError(error, { url?, role? })` maps a database failure to `{ code, cause, fix }`: `DB_PERMISSION_DENIED` (SQLSTATE `42501`, also inside Prisma `P2010`; `P1010`) with the `GRANT` for the app role, `DB_NOT_EMPTY_BASELINE` (`P3005`) with the `prisma migrate resolve --applied` baseline, `DB_UNREACHABLE` (`P1001`/`P1002`/`P1000`/`P1003`, `ECONNREFUSED`, …) and `DB_NOT_MIGRATED` (`P2021`, `42P01`). Credentials are redacted.
- `assertMigrated` attaches the diagnosis as `error.details.diagnosis` (the error code stays `PRISMA_NOT_MIGRATED`), and reports a permission failure as such — including PostgreSQL's silent case, where a role without `USAGE` on a schema sees its tables as "does not exist" — instead of "could not verify" or "not migrated".
- `tenant:migrate` prints the fix under a failing tenant.
- `dbStatusCommand()` builds `basalt db:status`: runs `prisma migrate status` for the central plane and every tenant, never changes anything, exits 1 on pending/failed/drifted/unreachable planes, `--json` for CI. Also exported: `parseMigrateStatus`, `prismaStatusArgs`, `npxPrismaRunner`.
