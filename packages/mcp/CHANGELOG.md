# @basaltkit/mcp

## 1.0.2

### Patch Changes

- 552cbe8: MCP foundations (RFC 0001 M0): extract a zero-dependency `@basaltkit/mcp-core` and grow the AI data contracts.
  
  - **New `@basaltkit/mcp-core`** (zero runtime dependencies): the JSON-RPC 2.0 + MCP wire protocol, a transport-neutral `McpServer` that dispatches over function-shaped tools/resources/prompts (with `AbortSignal` cancellation and progress plumbing), and a stdio transport. This is the shared wire that lets the runtime MCP surface and the forthcoming dev-only AI bridge reuse one protocol implementation without dragging the framework runtime into a developer's toolchain.
  - **`@basaltkit/mcp`** now builds its route-tools on top of `@basaltkit/mcp-core`. Public API and behaviour are unchanged (patch); the wire dispatch is delegated to the shared core.
  - **`@basaltkit/ai`** exports runtime `zod` schemas and a `toJsonSchema()` for its public data contracts (`ArchitecturePlan`, `MakeResult`, `AnalysisReport`, `ProjectContext`, `AgentReview`) — also available at the `@basaltkit/ai/schema` subpath. `parsePlan`/`parseReview` now validate their coerced output against these schemas, and `ArchitecturePlan`/`MakeResult` carry a `schemaVersion` for cross-process round-trips. Adds `zod` as a dependency of this dev-only package.
- Updated dependencies [552cbe8]
  - @basaltkit/mcp-core@0.2.0

## 0.2.3

### Patch Changes

- d41d1c7: Support Zod 4 when reading route schemas for tools. Object shapes (`_def.shape`
  is now a plain object, not a function) and scalar types (`_def.type` instead of
  `_def.typeName`) changed in v4, which broke tool argument splitting and the
  string→number/boolean coercion. Introspection is now version-agnostic.
- Updated dependencies [d41d1c7]
  - @basaltkit/http@1.5.1

## 0.2.2

### Patch Changes

- 3824868: Coerce stringified tool arguments to the scalar types their Zod schema declares.
  MCP clients/LLMs frequently send numbers and booleans as strings; the bridge now
  converts them (string → number/boolean) before validation, so routes with
  `z.number()`/`z.boolean()` fields no longer reject with "expected number,
  received string".

## 0.2.1

### Patch Changes

- 99bfe5d: Fix `tools/call` results for handlers that return a top-level array or primitive:
  `structuredContent` is now only set when the value is a JSON object (a record),
  per the MCP spec. Arrays/primitives ride in the text `content` only (with the
  full JSON), so clients no longer reject the result with "expected record,
  received array".

## 0.2.0

### Minor Changes

- e006b4b: New package `@basaltkit/mcp` — Model Context Protocol for Basalt. Expose opt-in
  routes (`meta.mcp`) as MCP tools over HTTP (`mcpRoutes()`, any adapter) or stdio
  (`serveMcpStdio()`), and consume external MCP servers as a client — either directly (`McpClient` with
  HTTP/stdio transports) or via `mcpClientPlugin({ servers })`, which registers a
  `MCP_CLIENTS` registry (connects at boot, closes on shutdown). Tool calls run through the neutral request pipeline,
  so validation, tenancy and auth apply exactly as over HTTP. Runtime package,
  independent of the dev-only `@basaltkit/ai` layer; no external SDK.

## 0.2.0

### Minor Changes

- 0cec7c3: New package `@basaltkit/mcp` — Model Context Protocol for Basalt. Expose opt-in
  routes (`meta.mcp`) as MCP tools over HTTP (`mcpRoutes()`, any adapter) or stdio
  (`serveMcpStdio()`), and consume external MCP servers as a client — either directly (`McpClient` with
  HTTP/stdio transports) or via `mcpClientPlugin({ servers })`, which registers a
  `MCP_CLIENTS` registry (connects at boot, closes on shutdown). Tool calls run through the neutral request pipeline,
  so validation, tenancy and auth apply exactly as over HTTP. Runtime package,
  independent of the dev-only `@basaltkit/ai` layer; no external SDK.
