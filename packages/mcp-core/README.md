# @basaltkit/mcp-core

Zero-dependency Model Context Protocol core for Basalt.

This package holds the parts of MCP that are independent of the application
runtime: the JSON-RPC 2.0 + MCP **wire protocol**, a **transport-neutral server**
that dispatches over function-shaped tools / resources / prompts (with progress
and cancellation plumbing), and a **stdio transport**. It has **no runtime
dependencies** — no `@basaltkit/core`, no `@basaltkit/http`, no SDK.

It is the shared foundation for two very different consumers:

- **`@basaltkit/mcp`** — the application's *runtime* MCP surface, which turns
  opted-in `BasaltRoute`s into tools and serves them over HTTP or stdio.
- **`@basaltkit/ai-mcp`** (dev-only, forthcoming) — the AI bridge, whose tools are
  plain functions (`analyze`, `plan`, `make`, `review`) and which must never pull
  the framework runtime into a developer's toolchain.

Keeping the wire in one zero-dependency package is what lets the dev-only bridge
reuse the exact same protocol implementation as the runtime server without
importing any framework runtime.

## What's here

- `protocol.ts` — `JsonRpcRequest/Response/Error`, `RPC_ERRORS`, `McpContent`,
  `McpToolResult`, `ok`/`fail`/`isNotification`/`negotiateVersion`, and the
  supported protocol versions.
- `McpServer` — construct from `{ tools, resources?, prompts?, serverInfo? }`.
  `handleMessage(message, ctx?)` implements `initialize`, `ping`, `tools/list`,
  `tools/call`, and — when registered — `resources/list`, `resources/read`,
  `prompts/list`, `prompts/get`. Resources and prompts are only advertised in the
  `initialize` capabilities when present, so a tools-only server is byte-for-byte
  a classic MCP tool server.
- `ToolInvokeContext` — every tool call receives an `AbortSignal` (client
  cancellation), an optional `progress` callback, an optional `elicit` hook, and
  opaque per-call `headers`.
- `serveStdio(server, options?)` — newline-delimited JSON-RPC over stdin/stdout.

## Example

```ts
import { McpServer, serveStdio, type McpToolDef } from '@basaltkit/mcp-core'

const echo: McpToolDef = {
  name: 'echo',
  description: 'Echo the input',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  async invoke(args) {
    return { content: [{ type: 'text', text: String(args['text'] ?? '') }] }
  },
}

const server = new McpServer({ tools: [echo], serverInfo: { name: 'demo', version: '1.0.0' } })
serveStdio(server)
```
