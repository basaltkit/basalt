---
'create-basalt': minor
---

The `basalt` CLI is now scaffolded by default.

Every new app gets `bin/basalt.ts`, the `pnpm basalt` script and the `make:*` generators (`@basaltkit/generator` as a devDependency) — on the command line and in every wizard preset (SaaS, API, Full stack and Minimal; pre-selected in Custom). Pass `--no-cli` to skip it; `--cli` is still accepted. Apps created with `--no-cli` still get `pnpm basalt update|add|doctor|info` through `create-basalt --project`, and `create-basalt add cli` adds the full CLI later.
