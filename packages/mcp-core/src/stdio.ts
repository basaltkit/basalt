import { fail, RPC_ERRORS, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js'
import type { CallContext } from './server.js'

/** The minimal server surface the stdio loop drives — {@link McpServer} satisfies it. */
export interface StdioServerLike {
  handleMessage(message: JsonRpcRequest, ctx?: CallContext): Promise<JsonRpcResponse | null>
}

export interface ServeStdioOptions {
  /** Static headers applied to every tool call — stdio has no per-request headers. */
  headers?: Record<string, string>
  /** Defaults to `process.stdin`. */
  input?: NodeJS.ReadableStream
  /** Defaults to `process.stdout`. */
  output?: { write(chunk: string): unknown }
}

/** A running stdio server. `close()` detaches the stdin listener. */
export interface StdioHandle {
  close(): void
}

/**
 * Serve MCP over stdio — newline-delimited JSON-RPC on stdin/stdout, the
 * transport local agents (Claude Desktop, IDEs) speak. Pure Node streams; no SDK.
 * The transport also supplies a `notify` callback so the dispatcher can push
 * server→client notifications (e.g. progress) back on the same stream.
 */
export function serveStdio(server: StdioServerLike, options: ServeStdioOptions = {}): StdioHandle {
  const input: NodeJS.ReadableStream = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const headers = options.headers ?? {}

  let buffer = ''
  const emit = (line: string): void => {
    output.write(`${line}\n`)
  }
  const notify = (message: JsonRpcRequest): void => emit(JSON.stringify(message))

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
    const response = await server.handleMessage(message, { headers, notify })
    if (response !== null) emit(JSON.stringify(response))
  }

  input.on('data', onData)
  return { close: () => input.off('data', onData) }
}
