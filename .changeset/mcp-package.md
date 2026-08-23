---
'@basaltkit/mcp': minor
---

New package `@basaltkit/mcp` — Model Context Protocol for Basalt. Expose opt-in
routes (`meta.mcp`) as MCP tools over HTTP (`mcpRoutes()`, any adapter) or stdio
(`serveMcpStdio()`), and consume external MCP servers as a client — either directly (`McpClient` with
HTTP/stdio transports) or via `mcpClientPlugin({ servers })`, which registers a
`MCP_CLIENTS` registry (connects at boot, closes on shutdown). Tool calls run through the neutral request pipeline,
so validation, tenancy and auth apply exactly as over HTTP. Runtime package,
independent of the dev-only `@basaltkit/ai` layer; no external SDK.
