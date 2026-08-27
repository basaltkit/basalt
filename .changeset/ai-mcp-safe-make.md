---
"@basaltkit/ai": minor
"@basaltkit/generator": minor
---

AI MCP bridge — M3 (safe make), RFC 0001 §E / §D.1(3).

- **`@basaltkit/ai`** adds a safe-preview to `runMake`: a dry-run now stats every target and returns `MakeResult.preview.perFile[]` (`{ path, action: 'create' | 'overwrite', diff }`) with unified diffs, plus `preview.clashes`. The preview writes nothing; `prisma db push`/`migrate` stays strictly opt-in. New `FilePreview`/`MakePreview` types and a dependency-free unified-diff generator. `runMake` (and its make types) are now reachable from the framework-free `@basaltkit/ai/workflows` subpath.
- **`@basaltkit/generator`** adds a framework-free **`@basaltkit/generator/resource`** subpath exposing `generateResource`/`writeGenerated`/`registerResourceInApp`/`names`/`FileExistsError` (+ types) **without** `generatorCommands` — which imports `@basaltkit/cli` (→ `@basaltkit/core`). `@basaltkit/ai`'s make engine now imports this subpath, so `runMake` no longer pulls the framework runtime, and dev-only consumers stay boundary-clean.
- **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains the `basalt_make` tool with a safety layer (`src/safety.ts`): **preview is the default and writes nothing**; `mode:'apply'` is explicit and refuses to overwrite a clash unless `force:true`; `prisma db push` runs only when `migrate:true` (double-gated); all writes are **confined to the launch workspace** (rejects `../` traversal, absolute paths, and symlink escapes before any write); an `apply` is confirmed via MCP elicitation when the client supports it, with the explicit preview→apply two-call flow as the floor. Plan↔make correlation is stateless — the client carries the full `ArchitecturePlan`. Progress via `ctx.progress`, cancellation via `ctx.signal`.
