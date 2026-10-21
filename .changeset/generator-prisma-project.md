---
"@basaltkit/generator": minor
---

`make:resource` now works end to end in an app scaffolded with `create-basalt --prisma`. It used to generate a repository that did not compile (`PrismaClient` imported from `@prisma/client`, which Prisma 7 no longer fills), a model left in a side file to paste, and a test that answered 500 for want of `prismaPlugin`. The `make:*` commands now read the project:

- `prisma/schema.prisma` exists → repositories are Prisma-backed by default (`--no-prisma` for in-memory);
- `package.json` maps `"#db/*"` → the repository is typed against `PrismaClient` from `#db/client.js`;
- the model is appended to `prisma/schema.prisma` (never twice), and the generator prints the `db:migrate` / `db:generate` line that creates the table; with no single schema file, or for a schema/database-per-tenant model, it is still written next to the module to paste;
- `src/db.ts` exports `db` → the generated test registers `prismaPlugin({ client: db })`, runs against the app database under fresh tenants each run, and skips when no database URL is set.

New: `appendPrismaModel()`, `PRISMA_SCHEMA` and the `testClient` option. Anything passed to `generatorCommands()` still wins over what is detected.
