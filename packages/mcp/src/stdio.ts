import type { Container } from '@basaltkit/core'
import { MCP, type McpServer } from './server.js'
import { fail, RPC_ERRORS, type JsonRpcRequest } from './protocol.js'

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
 * the `MCP` server is in the container. Pure Node streams; no SDK.
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
  const input: NodeJS.ReadableStream = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const headers = options.headers ?? {}

  let buffer = ''
  const emit = (line: string): void => {
    output.write(`${line}\n`)
  }

  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      void handleLine(line)
    }
  }

  const handleLine = async (line: string): Promise<void> => {
    let message: JsonRpcRequest
    try {
      message = JSON.parse(line)
    } catch {
      emit(JSON.stringify(fail(null, RPC_ERRORS.PARSE_ERROR, 'Parse error')))
      return
    }
    const response = await server.handleMessage(message, { headers })
    if (response !== null) emit(JSON.stringify(response))
  }

  input.on('data', onData)
  return { close: () => input.off('data', onData) }
}
