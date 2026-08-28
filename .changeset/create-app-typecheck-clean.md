---
"create-basalt": patch
---

Scaffolded apps now pass `pnpm typecheck` out of the box.

The templates emitted `LOG_LEVEL: z.string()` in `env.ts` and `logLevel?: string` in `BuildAppOptions` — both feeding `loggerPlugin({ level })`, which takes the `LogLevel` union — so a pristine scaffold's own `typecheck` script failed with TS2322. The templates now emit `z.enum(LOG_LEVELS)` and `logLevel?: LogLevel`. A new CI net scaffolds two app variants (default, and billing+cli+mcp) and compiles them with the real workspace packages, so template ↔ package type drift fails in this repo's CI instead of in a user's first typecheck.
