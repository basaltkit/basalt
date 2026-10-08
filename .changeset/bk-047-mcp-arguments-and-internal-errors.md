---
'@basaltkit/mcp-core': minor
'@basaltkit/mcp': minor
'@basaltkit/ai-mcp': minor
---

Reject malformed MCP `arguments` and stop echoing internal exception text (BK-047).

- `@basaltkit/mcp-core`: `tools/call` now refuses a present-but-non-object `arguments` (array, string, number, `null`) with `INVALID_PARAMS` before the tool runs, and `prompts/get` requires an object of string values. An unexpected throw from a tool, resource or prompt now answers `INTERNAL_ERROR` with the generic text `Internal error` instead of the exception's `message` (which could carry secrets, paths or SQL). An error with `expose: true` keeps its message. The new `McpServerOptions.onError(error, message)` hook receives the original error for logging. Clients that parsed the `-32603` message text will now see `Internal error`.
- `@basaltkit/mcp`: building the route request from tool arguments (argument splitting, URL filling) now runs inside the tool's error handling, so a failure there ends as a sanitised `isError` result instead of a raw `TypeError` text. New `onError` option on `mcpPlugin` / `McpServer` (and exported `reportMcpInternalError`, the default): an error that escapes a tool's own handling — the client sees only `Internal error` — is written as one line to stderr (never stdout, which carries the stdio protocol). Pass your own hook, or `false` to silence it.
- `@basaltkit/ai-mcp`: new `onError` option on `AiMcpOptions`; the `basalt-ai-mcp` bin logs the real cause of an internal error to stderr.
