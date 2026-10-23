---
"@basaltkit/prisma": patch
"@basaltkit/ai": patch
---

The Prisma CLI is always the project's own: `npx --no -- prisma …`, never a download.

`migrateTenants`/`prismaMigrator`, `db:status`, `prisma:sync --migrate|--push` and `ai:make --migrate` ran `npx prisma …`. In a project (or a CI image) without a local `prisma`, npx installed whatever npm calls `latest`, and since October 2026 that is the Prisma 8 release candidate, whose CLI has no `migrate deploy`, `migrate status` or `db push`. npx now refuses instead ("npx canceled due to missing packages"), so a missing CLI is a clear error rather than a different Prisma. `--` keeps Prisma's flags away from npx's own option parser. Nothing changes for a project that has `prisma` installed.
