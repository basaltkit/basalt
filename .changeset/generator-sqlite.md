---
"@basaltkit/generator": minor
---

`make:resource --sqlite`: a repository over `node:sqlite` (no ORM), opened with `database()` from `src/db.ts`. The table's `CREATE TABLE` is appended to the `MIGRATIONS` there; the first time, `src/db.ts` is created, `DATABASE_PATH` declared in `src/env.ts` and `data/` added to `.gitignore`. Tenant-owned resources get an indexed `tenant_id` column and `requireTenantId()` in every statement (`--tenant=schema|database` needs `--prisma`). Once `src/db.ts` is that module, `--sqlite` is the default (`--no-sqlite` to opt out).
