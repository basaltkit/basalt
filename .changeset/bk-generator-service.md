---
'@basaltkit/generator': minor
---

`make:service` no longer generates a file that does not compile (BK-020).

- Run on its own, `basalt make:service <Name>` emitted the CRUD service — importing `./<name>.repository.js` and `./<name>.schema.js`, neither of which it generates. The file failed the first `tsc` with two `TS2307`s, and every non-CRUD domain service (orchestration, rules, transactions) started by deleting those imports. The command now checks the target directory first: with both sibling files there (after `make:resource`, or written by hand) it emits the CRUD service exactly as before; with either missing it emits a **minimal service** — the class, its `createToken` injection token and a constructor with no dependencies, importing nothing but `@basaltkit/core` — plus a TODO pointing at `make:resource` for the CRUD vertical. A note after generation says which shape was written.
- New flags `--crud` / `--no-crud` (`make:service` only) force either shape. `GeneratorOptions.crud?: boolean` is the programmatic equivalent; left undefined, `generate('service', …)` keeps the CRUD default, so existing callers are unaffected.
- New export `serviceSiblingsExist(name, { baseDir })` — what the CLI consults.
- `make:resource` is unchanged: the vertical always gets the CRUD service, stated explicitly (`crud: true`) rather than riding on the default, so `@basaltkit/ai`'s `ai:make`, which calls `generateResource`, keeps emitting the same files.

Every other `make:<kind>` had the same failure mode — the plugin imports the repository and the service, the routes the service and the schema, the test the plugin and the routes, the repository the schema — and is now checked the same way:

- Before writing, `make:<kind>` computes which of the files the artifact imports are neither generated in this run nor already on disk, and prints them with the command that creates them: `Warning: src/modules/invoice/invoice.plugin.ts imports 2 file(s) that do not exist yet: …` / `Generate the whole vertical with 'basalt make:resource Invoice', or write them yourself — until then this file does not compile.` The file is still written (the sibling may be about to be written by hand) and the exit code is unchanged. `make:schema` never warns (it imports nothing of the module), `make:resource` never warns (it writes them all), and `make:service` keeps its minimal-shape note instead.
- New exports: `expectedSiblings(kind, name, options?)` (pure, the per-kind table; empty for a minimal service), `missingSiblings(kind, name, options?, write?)` (that minus what is on disk) and `missingSiblingsWarning(name, generatedPath, missing)` (the exact lines the CLI prints), so the dev-only AI/MCP paths and editor tooling can surface the same information. `moduleFile(names, artifact)` is now the single place the `src/modules/<name>/<name>.<artifact>.ts` layout is spelled out; it replaces the `serviceSiblingPaths` helper added earlier in this changeset.
