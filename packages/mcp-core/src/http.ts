import { createServer, type Server } from 'node:http'
import { fail, RPC_ERRORS, type JsonRpcRequest } from './protocol.js'
import type { StdioServerLike } from './stdio.js'
import type { CallContext } from './server.js'

export interface ServeHttpOptions {
  /** Port to listen on. `0` (default) picks an ephemeral port. */
  port?: number
  /** Host to bind. Default `127.0.0.1` (loopback — a dev-only surface). */
  host?: string
  /** JSON-RPC endpoint path. Default `/mcp`. */
  path?: string
}

export interface HttpHandle {
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

/**
 * Serve MCP over a minimal Node `http` server — POST JSON-RPC to `/mcp`, one
 * request/response per call (the Streamable-HTTP JSON path, no SSE). Intended as
 * an opt-in remote/CI transport; stdio stays the primary local-dev transport.
 *
 * Deliberately minimal: it uses only `node:http`, never `@basaltkit/http`, so a
 * dev-only server keeps the framework runtime out of its dependency graph.
 * Server→client notifications (progress) are not delivered over this transport —
 * use stdio when you need live progress.
 */
export function serveHttp(server: StdioServerLike, options: ServeHttpOptions = {}): Promise<HttpHandle> {
  const host = options.host ?? '127.0.0.1'
  const path = options.path ?? '/mcp'

  const httpServer: Server = createServer((req, res) => {
    if (req.method !== 'POST' || (req.url ?? '/').split('?')[0] !== path) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(fail(null, RPC_ERRORS.METHOD_NOT_FOUND, `Not found: ${req.method} ${req.url}`)))
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      void handle(body, res)
    })
  })

  const handle = async (body: string, res: import('node:http').ServerResponse): Promise<void> => {
    let message: JsonRpcRequest
    try {
      message = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(fail(null, RPC_ERRORS.PARSE_ERROR, 'Parse error')))
      return
    }
    // HTTP has no server→client channel here; `headers` carry per-call metadata.
    const ctx: CallContext = { headers: normalizeHeaders(res.req.headers) }
    const response = await server.handleMessage(message, ctx)
    if (response === null) {
      res.writeHead(202)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  return new Promise<HttpHandle>((resolve) => {
    httpServer.listen(options.port ?? 0, host, () => {
      const address = httpServer.address()
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
      resolve({
        port,
        url: `http://${host}:${port}${path}`,
        close: () =>
          new Promise<void>((done, reject) => httpServer.close((err) => (err ? reject(err) : done()))),
      })
    })
  })
}

function normalizeHeaders(
  headers: import('node:http').IncomingHttpHeaders,
): Record<string, string | string[] | undefined> {
  return headers as Record<string, string | string[] | undefined>
}
