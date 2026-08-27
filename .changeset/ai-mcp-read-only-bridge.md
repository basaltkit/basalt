---
"@basaltkit/ai": minor
---

AI MCP bridge — M1 (read-only), RFC 0001 §E.

- **New `@basaltkit/ai-mcp`** (dev-only, debuts at 0.1.0): a Model Context Protocol server that exposes Basalt's AI developer workflows to MCP clients (Claude Desktop/Code) over stdio, via the `basalt-ai-mcp` bin. M1 is read-only — no AI provider, no file writes:
  - Tools: `basalt_analyze` (stack, data model, diagnostics) and `basalt_doctor` (diagnostics + in-memory auto-fix previews).
  - Resources: `basalt://project/{context,analysis,diagnostics}` and `basalt://knowledge/architecture`.
  - Depends only on `@basaltkit/ai` + `@basaltkit/mcp-core`; it never pulls the framework runtime (`@basaltkit/core`/`http`) or the runtime `@basaltkit/mcp` into its graph (enforced by a boundary test).
- **`@basaltkit/ai`** gains a framework-free `@basaltkit/ai/analysis` subpath that re-exports the read-only surface (`detectProject`, `analyze`, `runDoctor`, `planFix`, `BASALT_KNOWLEDGE`, …) **without** the `basalt ai` CLI wiring. The main barrel re-exports `aiCommands`, which imports `@basaltkit/cli` → `@basaltkit/core`; the new subpath lets dev-only, out-of-process consumers use analyze/doctor without dragging the framework runtime into their dependency graph.
