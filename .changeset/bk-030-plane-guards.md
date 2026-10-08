---
"@basaltkit/prisma": minor
---

Guard against migrating the wrong plane (BK-030).

- `assertMigrated({ forbiddenTables })` (and `prismaPlugin({ assertMigrated: { forbiddenTables } })`): tables that must NOT exist — typically tenant tables recreated in the central database by a root `prisma migrate dev`. Any present one fails with `DatabasePlaneMixedError` (`PRISMA_PLANE_MIXED`, `details.tables`). Checked the same way as `tables`, so it works on PostgreSQL, MySQL and SQLite.
- `prisma:sync` with `targets`: prints the missing per-plane `prisma.config.ts` (own `schema` and `migrations.path`; `--yes` writes it, never over an existing file), and warns when the root `prisma.config.ts` still declares `migrations`/`datasource`, printing a generate-only replacement (never rewritten for you). New helpers `planeConfigTs()` and `generateOnlyRootConfigTs()`.
