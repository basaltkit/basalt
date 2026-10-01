---
'create-basalt': minor
---

Development entrypoints load `.env`; `upgrade` and env errors no longer need a booting app.

- `src/dev.ts` (`pnpm dev`) and `bin/basalt.ts` (`pnpm basalt`) load the project's `.env` when it exists, with `node --env-file` semantics (`process.loadEnvFile`: a variable already exported in the shell wins). `pnpm start` / `src/server.ts` still loads nothing — production configuration comes from the real environment. Until now nothing loaded `.env`, so a fresh `--prisma` app failed `pnpm basalt …` / `pnpm dev` with `EnvValidationError` although `.env` held the URL.
- New apps get a ready-to-use, git-ignored `.env` (mode 0600, not in the manifest): the values of `.env.example` plus, with auth, a generated `APP_SECRET`. The `.env.example` header now says dev/CLI load it and `start` does not.
- `bin/basalt.ts` runs `upgrade` (the `@basaltkit/cli` codemods) before importing the app, and turns a boot-time `EnvValidationError` into the list of variables, where they were read from and the fix (exit 1, no stack trace; `BASALT_DEBUG=1` / `--debug` keeps it).
- `create-basalt update` patches an unmodified `bin/basalt.ts` (1.9 and 1.10 templates included), `src/dev.ts` (1.9/1.10) and the old `.env.example` header; customised files get the exact snippet.
- `doctor` reports every variable `src/env.ts` requires (no default) that is set neither in the environment nor in `.env` as an error with the fix (previously `DATABASE_URL` was only a warning), warns when `.env` is missing next to `.env.example`, and flags an outdated `src/dev.ts`.
- `bin/basalt.ts` also explains database boot failures: PostgreSQL not answering (`ECONNREFUSED`, Prisma `P1001`, an `assertMigrated` that could not query) and an unmigrated database (`PRISMA_NOT_MIGRATED`) — what failed, the database in use as `protocol://host:port/name` plus the variable it came from (credentials never printed) and the fix (start PostgreSQL, check the URL, `pnpm db:migrate`). Unknown errors are rethrown unchanged.
