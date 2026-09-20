---
'create-basalt': minor
---

Add `--prisma` (alias `--db`): scaffold a PostgreSQL-backed app instead of a memory-only one.

Until now every generated app booted on in-memory sources, so `prismaPlugin({ assertMigrated: true })` — the boot-time check that catches an app pointed at an unmigrated or simply *wrong* database — had nothing to guard. `--prisma` generates the database-backed shape:

- `prisma/schema.prisma` composed from the reference models of every `@basaltkit/*-prisma` package the project uses (the same blocks `basalt prisma:sync` merges) plus an app-owned `Project` model, and `prisma.config.ts` carrying the connection URL (Prisma 7).
- `src/db.ts` with the unscoped `prisma` client for the framework stores and, with tenancy, `db = prisma.$extends(tenancyExtension())`.
- `src/app.ts` wiring `prismaPlugin({ client: db, assertMigrated: true })`, `prismaTenantSource`, `prismaAuthStores`, `prismaTeamsStores` and `prismaSubscriptionsStores` in place of the memory ones, plus a `prisma/seed.ts` for the `demo` tenant.
- `<APP>_DATABASE_URL` as a required variable (same prefixed-first precedence in `src/env.ts` and `prisma.config.ts`), `.env.example` updated, and `db:generate` / `db:migrate` / `db:deploy` / `db:seed` scripts — migrations only, because `prisma db push` writes no `_prisma_migrations` table for `assertMigrated` to find.

Without the flag the scaffold is unchanged: no database, no Prisma dependency, the same memory sources as before.
