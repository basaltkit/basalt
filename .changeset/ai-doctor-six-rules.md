---
'@basaltkit/ai': minor
---

`ai:doctor` gains six rules:

- `schema-not-migrated` (error): a model no migration creates — a table that exists only through `db push` is missing after `prisma migrate deploy`.
- `framework-schema-drift` (warning): a framework model lacks columns of the installed `-prisma` package's reference schema (MySQL apps are compared with `schema.mysql.prisma`); fix with `basalt prisma:sync`.
- `plugin-default-memory-store` (warning): the app has a database but `commentsPlugin`, `activityPlugin`, `auditPlugin`, `filesPlugin`, `notificationsPlugin`, `teamsPlugin`, `webhooksPlugin` or `outboxPlugin` is called without its store, so it keeps the data in memory.
- `context-at-module-scope` (error): a top-level `const` in `src/` calls `ctx()`, `tryCtx()` or `db()` (aliases followed) — it runs at import time, outside any request.
- `detached-hook-bus` (warning): `new HookBus()` in `src/`, a bus the app's events never reach.
- `zod-v3-import` (warning): imports from `zod/v3`, whose schemas the route pipeline's Zod 4 OpenAPI/MCP conversion cannot read.

`ProjectContext` carries what they read: `migrations`, `frameworkSchemas`, `sourceHints` and `app.defaultMemoryStores`. `memoryReader().exists()` now answers true for a folder that holds files, as the disk reader does.
