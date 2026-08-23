# @basaltkit/mcp

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
