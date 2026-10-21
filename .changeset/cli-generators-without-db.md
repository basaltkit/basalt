---
"create-basalt": patch
---

`pnpm basalt make:*` no longer boots the app: like `upgrade`, the generators run before `src/app.ts` is imported, so they work while the database is down or not yet migrated (a `--prisma` app refused to generate code until `pnpm db:migrate` had run). `create-basalt update` patches an untouched `bin/basalt.ts` from an earlier release; a customised one gets the snippet. Also: with `--prisma --no-tenancy`, the comment on `prismaPlugin` in `src/app.ts` no longer claims the client is tenant-scoped.
