---
"@basaltkit/ai": minor
"@basaltkit/mcp": patch
---

MCP foundations (RFC 0001 M0): extract a zero-dependency `@basaltkit/mcp-core` and grow the AI data contracts.

- **New `@basaltkit/mcp-core`** (zero runtime dependencies): the JSON-RPC 2.0 + MCP wire protocol, a transport-neutral `McpServer` that dispatches over function-shaped tools/resources/prompts (with `AbortSignal` cancellation and progress plumbing), and a stdio transport. This is the shared wire that lets the runtime MCP surface and the forthcoming dev-only AI bridge reuse one protocol implementation without dragging the framework runtime into a developer's toolchain.
- **`@basaltkit/mcp`** now builds its route-tools on top of `@basaltkit/mcp-core`. Public API and behaviour are unchanged (patch); the wire dispatch is delegated to the shared core.
- **`@basaltkit/ai`** exports runtime `zod` schemas and a `toJsonSchema()` for its public data contracts (`ArchitecturePlan`, `MakeResult`, `AnalysisReport`, `ProjectContext`, `AgentReview`) — also available at the `@basaltkit/ai/schema` subpath. `parsePlan`/`parseReview` now validate their coerced output against these schemas, and `ArchitecturePlan`/`MakeResult` carry a `schemaVersion` for cross-process round-trips. Adds `zod` as a dependency of this dev-only package.
