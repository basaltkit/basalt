---
"@basaltkit/mcp": major
---

Harden the runtime MCP surface (framework audit FA-034 – FA-038).

**Breaking** (hence major — each changes a default a caller may rely on):

- `POST /mcp` now answers **403** to a request whose `Origin` header is neither
  same-origin nor listed in the new `mcpRoutes({ allowedOrigins })` (`'*'`
  disables the check), and **415** unless the body is sent as
  `application/json`. Non-browser MCP clients send no `Origin` and are
  unaffected; a browser-hosted client on another origin must be allow-listed.
- A tool call no longer inherits every header of the `/mcp` request. It gets
  an allowlist — `DEFAULT_FORWARDED_HEADERS` (`authorization`, `cookie`,
  `x-api-key`, `x-tenant-id`, `host`, `accept-language`, `user-agent`) — and
  `mcpPlugin({ forwardHeaders })` extends it. `x-request-id`, `if-none-match`,
  forwarding and hop-by-hop headers are dropped. The same filter applies to
  `McpServer.callTool(name, args, { headers })`.
- A handler that replies `reply.code(status)` with `status >= 400` now yields a
  tool result with `isError: true` (it used to arrive as a success).

**Fixes / additions:**

- The synthetic tool request carries the caller's `ip` (`ToolCallContext.ip`;
  the `/mcp` route passes `request.ip`), `routePattern` (the tool route's
  template) and the concrete `url` built from the arguments (encoded params +
  query string) instead of the route template.
- Cancellation reaches route-backed tools: the abort signal is passed through,
  the call answers "cancelled" (`isError`) as soon as it fires, and a handler
  can observe it with the new `toolSignal(request)`.
- `mcpRoutes({ auth: true })` sets `meta.auth` on the endpoint so even
  `initialize`/`tools/list` require an authenticated caller; `mcpRoutes({ meta })`
  adds any other guard key.
- `/mcp` accepts JSON-RPC batches; each POST is its own MCP session, so a
  cancel from one caller never reaches another's request.
