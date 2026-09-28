import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fail, RPC_ERRORS } from './protocol.js'
import { isInitializeRequest, MCP_SESSION_HEADER, McpSessions, type McpSessionOptions } from './sessions.js'
import type { StdioServerLike } from './stdio.js'
import type { CallContext } from './server.js'
import { dispatchPayload } from './dispatch.js'

/** Default request-body cap: 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

export interface ServeHttpOptions {
  /** Port to listen on. `0` (default) picks an ephemeral port. */
  port?: number
  /**
   * Host to bind. Default `127.0.0.1` (loopback — a dev-only surface). Binding
   * a non-loopback address (e.g. `0.0.0.0`) is REFUSED unless `authorize` or
   * `allowRequest` is also set: the `Host`/`Origin` guard is not authentication
   * (any non-browser client can send `Host: 127.0.0.1`), so a network-reachable
   * server needs a real check.
   */
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
   * `undefined` when absent), `host` header and the raw request (headers,
   * `socket.remoteAddress`); return `true` to allow. When set, it replaces the
   * default loopback + `allowedHosts`/`allowedOrigins` checks.
   */
  allowRequest?: (origin: string | undefined, host: string | undefined, req: IncomingMessage) => boolean
  /**
   * Authenticate a request that passed the host/origin guard — e.g. compare a
   * bearer token. Return `false` to answer 401. Required (or `allowRequest`)
   * when binding a non-loopback `host`.
   */
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>
  /**
   * Largest accepted request body, in bytes. A larger body is answered 413 and
   * is never buffered. Default {@link DEFAULT_MAX_BODY_BYTES} (1 MiB).
   */
  maxBodyBytes?: number
  /**
   * Streamable-HTTP sessions — opt-in (`true`, or `{ ttlMs, maxSessions }`).
   * A successful `initialize` then answers with an `Mcp-Session-Id` header;
   * every later request must carry it (400 without it, 404 for an unknown,
   * expired or foreign one — the client then re-initializes) and `DELETE`
   * with it ends the session. All requests of a session share one
   * cancellation scope, so a `notifications/cancelled` POSTed separately
   * aborts the call it names — while another session, even one guessing the
   * request id, never can.
   *
   * Default `false` (stateless): each POST is its own session, no header is
   * issued or required, and only a client disconnect cancels a call. The
   * default stays stateless so existing header-less clients of a dev bridge
   * keep working; the runtime `/mcp` route of `@basaltkit/mcp` turns sessions
   * on by default.
   */
  sessions?: boolean | McpSessionOptions
  /**
   * Who is calling, for binding sessions: a session is only usable by requests
   * that resolve to the principal that opened it. Default: a hash of the
   * `Authorization` header (so one bearer token cannot use another's session;
   * without `Authorization`, every caller is the same principal and the
   * unguessable id alone protects the session).
   */
  principal?: (req: IncomingMessage) => string | undefined | Promise<string | undefined>
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

/** True when a bind address is a loopback interface. */
function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(h) || h.startsWith('127.') || h === '::ffff:127.0.0.1'
}

/**
 * Guard an incoming request against DNS-rebinding (via the `Host` header) and
 * cross-site/CSRF driving (via the `Origin` header). This is a BROWSER guard,
 * not authentication: the `Host` header is whatever the client sends, so any
 * non-browser client passes it. Secure-by-default:
 *
 * - the `Host` hostname must be a loopback name (or in `allowedHosts`);
 * - if an `Origin` is present it must be a loopback origin (or in
 *   `allowedOrigins`) — a browser always sends `Origin` on a cross-site POST, so
 *   its absence means a non-browser client (curl, an MCP HTTP client) and is allowed.
 */
function isAllowedRequest(
  origin: string | undefined,
  host: string | undefined,
  req: IncomingMessage,
  options: ServeHttpOptions,
): boolean {
  if (options.allowRequest) return options.allowRequest(origin, host, req)

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
 *
 * With `sessions` on (opt-in), `Mcp-Session-Id` scopes cancellation: a
 * `notifications/cancelled` POSTed in a later request of the same session
 * aborts the call it names; no other session can. Stateless (the default),
 * each request is its own session. A call is always aborted when its client
 * disconnects before the response is written.
 * JSON-RPC batches are accepted. Bodies over `maxBodyBytes` get 413 without
 * being buffered.
 */
export function serveHttp(server: StdioServerLike, options: ServeHttpOptions = {}): Promise<HttpHandle> {
  const host = options.host ?? '127.0.0.1'
  const path = options.path ?? '/mcp'
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const sessions =
    options.sessions === undefined || options.sessions === false
      ? undefined
      : new McpSessions(options.sessions === true ? {} : options.sessions)

  if (!isLoopbackBind(host) && !options.authorize && !options.allowRequest) {
    return Promise.reject(
      new Error(
        `serveHttp: refusing to bind non-loopback host '${host}' without \`authorize\` (or \`allowRequest\`). ` +
          'The Host/Origin guard is not authentication — any network client can send `Host: 127.0.0.1`.',
      ),
    )
  }

  const reject = (res: ServerResponse, status: number, code: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(fail(null, code, message)))
  }

  const httpServer: Server = createServer((req, res) => {
    // Security guard runs BEFORE routing/dispatch — a rejected request never
    // reaches a tool. Blocks DNS-rebinding (foreign Host) and CSRF (foreign Origin).
    const originHeader = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
    const hostHeader = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
    if (!isAllowedRequest(originHeader, hostHeader, req, options)) {
      req.resume()
      reject(res, 403, RPC_ERRORS.INVALID_REQUEST, 'Forbidden: host/origin not allowed')
      return
    }
    const onPath = (req.url ?? '/').split('?')[0] === path
    if (onPath && req.method === 'DELETE' && sessions) {
      req.resume()
      void endSession(req, res)
      return
    }
    if (req.method !== 'POST' || !onPath) {
      req.resume()
      reject(res, 404, RPC_ERRORS.METHOD_NOT_FOUND, `Not found: ${req.method} ${req.url}`)
      return
    }
    void readAndHandle(req, res)
  })

  const tooLarge = (req: IncomingMessage, res: ServerResponse): void => {
    // Stop buffering: the rest of the body is drained to the void (bounded by the
    // server's request timeout) so the client can still read the 413 instead of
    // hitting a connection reset mid-upload.
    req.removeAllListeners('data')
    req.resume()
    reject(res, 413, RPC_ERRORS.INVALID_REQUEST, `Request body exceeds ${maxBodyBytes} bytes`)
  }

  const principalOf = async (req: IncomingMessage): Promise<string> => {
    if (options.principal) return (await options.principal(req)) ?? ''
    const auth = headerOf(req, 'authorization')
    return auth === undefined ? '' : createHash('sha256').update(auth).digest('base64url')
  }

  const authorized = async (req: IncomingMessage): Promise<boolean> => {
    if (!options.authorize) return true
    try {
      return await options.authorize(req)
    } catch {
      return false
    }
  }

  const endSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await authorized(req))) return reject(res, 401, RPC_ERRORS.INVALID_REQUEST, 'Unauthorized')
    const ended = sessions!.delete(headerOf(req, MCP_SESSION_HEADER), await principalOf(req))
    if (!ended) return reject(res, 404, RPC_ERRORS.INVALID_REQUEST, 'Session not found')
    res.writeHead(204)
    res.end()
  }

  const readAndHandle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(await authorized(req))) {
      req.resume()
      reject(res, 401, RPC_ERRORS.INVALID_REQUEST, 'Unauthorized')
      return
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      tooLarge(req, res)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        overflow = true
        chunks.length = 0
        tooLarge(req, res)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overflow) void handle(Buffer.concat(chunks).toString('utf8'), req, res)
    })
  }

  const handle = async (body: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      reject(res, 400, RPC_ERRORS.PARSE_ERROR, 'Parse error')
      return
    }
    // The cancellation scope: the session (shared by all its requests), or —
    // stateless — this request alone.
    let session: object = {}
    let issued: string | undefined
    let principal = ''
    if (sessions) {
      principal = await principalOf(req)
      if (isInitializeRequest(payload)) {
        const opened = sessions.create(principal)
        session = opened
        issued = opened.id
      } else {
        const id = headerOf(req, MCP_SESSION_HEADER)
        if (id === undefined) {
          reject(res, 400, RPC_ERRORS.INVALID_REQUEST, 'Bad Request: Mcp-Session-Id header required (send initialize first)')
          return
        }
        const found = sessions.resolve(id, principal)
        if (!found) {
          reject(res, 404, RPC_ERRORS.INVALID_REQUEST, 'Session not found (expired or unknown) — initialize again')
          return
        }
        session = found
      }
    }
    // A client that goes away before its answer is written cancels the call.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    // HTTP has no server→client channel here; `headers` carry per-call metadata.
    const ctx: CallContext = {
      headers: normalizeHeaders(req),
      session,
      signal: controller.signal,
      ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}),
    }
    const response = await dispatchPayload(server, payload, ctx)
    // A failed initialize opens nothing.
    if (issued !== undefined && (response === null || Array.isArray(response) || response.error !== undefined)) {
      sessions!.delete(issued, principal)
      issued = undefined
    }
    if (res.destroyed) return
    if (response === null) {
      res.writeHead(202)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(issued !== undefined ? { [MCP_SESSION_HEADER]: issued } : {}),
    })
    res.end(JSON.stringify(response))
  }

  // `[::1]` and `::1` name the same interface: `listen()` wants it bare, a URL
  // wants it bracketed (`http://::1:8848/mcp` is not a URL).
  const bindHost = host.trim().replace(/^\[(.*)\]$/, '$1')
  const urlHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost

  return new Promise<HttpHandle>((resolve, rejectListen) => {
    // A port already in use (or an address this machine does not have) is an
    // error to the caller — not an unhandled 'error' event and a promise that
    // never settles.
    const onListenError = (error: Error): void => rejectListen(error)
    httpServer.once('error', onListenError)
    httpServer.listen(options.port ?? 0, bindHost, () => {
      httpServer.off('error', onListenError)
      const address = httpServer.address()
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
      resolve({
        port,
        url: `http://${urlHost}:${port}${path}`,
        close: () =>
          new Promise<void>((done, reject) => httpServer.close((err) => (err ? reject(err) : done()))),
      })
    })
  })
}

/** One request header's first value. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * The request headers as tools see them: a header sent once is a string, a
 * header sent more than once is an array of every value, in order.
 *
 * `req.headers` would not do: Node joins most repeated headers with `, `
 * (`x-tenant: a` twice becomes `'a, a'`… or `'acme, globex'`) and silently keeps
 * only the first of others (`authorization`, `host`, `content-type`), so a tool
 * could never apply "a duplicated header is ambiguous — refuse". Built from
 * `headersDistinct`, which keeps the multiplicity.
 */
function normalizeHeaders(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    if (values === undefined || values.length === 0) continue
    headers[name] = values.length === 1 ? values[0] : values
  }
  return headers
}
