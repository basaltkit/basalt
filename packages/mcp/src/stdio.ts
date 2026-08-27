import type { Container } from '@basaltkit/core'
import { serveStdio } from '@basaltkit/mcp-core'
import { MCP, type McpServer } from './server.js'

export interface McpStdioOptions {
  /** Static headers applied to every tool call (e.g. a service tenant/token) — stdio has no per-request headers. */
  headers?: Record<string, string>
  /** Defaults to `process.stdin`. */
  input?: NodeJS.ReadableStream
  /** Defaults to `process.stdout`. */
  output?: { write(chunk: string): unknown }
}

/** A running stdio server. `close()` detaches the stdin listener. */
export interface McpStdioHandle {
  close(): void
}

/**
 * Serve MCP over stdio — newline-delimited JSON-RPC on stdin/stdout, the
 * transport local agents (Claude Desktop, IDEs) speak. Requires `mcpPlugin` so
 * the `MCP` server is in the container. The transport itself lives in the
 * zero-dependency `@basaltkit/mcp-core`; this wrapper resolves the runtime
 * server from the container.
 *
 * ```ts
 * const app = await buildApp().boot()
 * serveMcpStdio(app)
 * ```
 */
export function serveMcpStdio(
  app: { container: Container },
  options: McpStdioOptions = {},
): McpStdioHandle {
  const server: McpServer = app.container.get(MCP)
  return serveStdio(server, options)
}
