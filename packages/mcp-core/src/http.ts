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
  /**
   * Extra hostnames to accept in the `Host` header, beyond the loopback names
   * (`localhost`, `127.0.0.1`, `::1`). Set this when you deliberately bind a
   * non-loopback `host` (e.g. `0.0.0.0` for remote/CI). Compared case-insensitively
   * against the hostname only (port is ignored).
   */
  allowedHosts?: string[]
  /**
   * Extra origins to accept in the `Origin` header, beyond loopback origins.
   * Compared case-insensitively against the full origin (scheme + host + port).
   */
  allowedOrigins?: string[]
  /**
   * Full override of the request-guard. Receives the request's `origin` (or
   * `undefined` when absent) and `host` header; return `true` to allow. When set,
   * it replaces the default loopback + `allowedHosts`/`allowedOrigins` checks.
   */
  allowRequest?: (origin: string | undefined, host: string | undefined) => boolean
}

export interface HttpHandle {
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

/** Loopback hostnames — the only ones the dev bridge trusts by default. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Extract the hostname (no port) from a `Host` header value. `[::1]:8848` → `::1`. */
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(1, end) // IPv6 literal, brackets stripped
  }
  const colon = value.indexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

/** True when an origin string is a loopback origin (any scheme/port). */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return LOOPBACK_HOSTS.has(host) || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * Guard an incoming request against DNS-rebinding (via the `Host` header) and
 * cross-site/CSRF driving (via the `Origin` header). Secure-by-default:
 *
 * - the `Host` hostname must be a loopback name (or in `allowedHosts`);
 * - if an `Origin` is present it must be a loopback origin (or in
 *   `allowedOrigins`) — a browser always sends `Origin` on a cross-site POST, so
 *   its absence means a non-browser client (curl, an MCP HTTP client) and is allowed.
 */
function isAllowedRequest(
  origin: string | undefined,
  host: string | undefined,
  options: ServeHttpOptions,
): boolean {
  if (options.allowRequest) return options.allowRequest(origin, host)

  // Host header (anti-DNS-rebinding): a rebinding attack arrives with a foreign Host.
  if (host === undefined) return false
  const hostname = hostnameOf(host)
  const allowedHosts = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()))
  if (!LOOPBACK_HOSTS.has(hostname) && !allowedHosts.has(hostname)) return false

  // Origin header (anti-CSRF): only validated when present (browsers always send it).
  if (origin !== undefined) {
    const allowedOrigins = new Set((options.allowedOrigins ?? []).map((o) => o.toLowerCase()))
    if (!isLoopbackOrigin(origin) && !allowedOrigins.has(origin.toLowerCase())) return false
  }
  return true
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
    // Security guard runs BEFORE routing/dispatch — a rejected request never
    // reaches a tool. Blocks DNS-rebinding (foreign Host) and CSRF (foreign Origin).
    const originHeader = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
    const hostHeader = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
    if (!isAllowedRequest(originHeader, hostHeader, options)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify(fail(null, RPC_ERRORS.INVALID_REQUEST, 'Forbidden: host/origin not allowed')))
      return
    }
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
