import { createHash } from 'node:crypto'
import { createToken, ctx, definePlugin, type Container } from '@basaltkit/core'
import { HttpError, route, type BasaltRoute, type HttpRequest } from '@basaltkit/http'
import { z } from 'zod'
import {
  dispatchPayload,
  isInitializeRequest,
  MCP_SESSION_HEADER,
  McpServer as CoreServer,
  McpSessions,
  RPC_ERRORS,
  fail,
  type CallContext,
  type McpSessionOptions,
  type McpToolDef,
  type McpToolResult,
} from '@basaltkit/mcp-core'
import { collectTools, type McpTool, type ToolCallContext } from './tools.js'
import { type JsonRpcRequest, type JsonRpcResponse } from './protocol.js'

export interface McpServerInfo {
  name: string
  version: string
}

export interface McpServerOptions {
  routes: BasaltRoute[]
  container: Container
  serverInfo?: McpServerInfo
  filter?: (route: BasaltRoute) => boolean
  /** Extra request headers a tool call inherits, on top of `DEFAULT_FORWARDED_HEADERS`. */
  forwardHeaders?: string[]
}

/** Adapt a route-backed {@link McpTool} to the core's function-shaped {@link McpToolDef}. */
function toToolDef(tool: McpTool): McpToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    invoke: (args, invokeCtx) =>
      tool.invoke(args, {
        signal: invokeCtx.signal,
        ...(invokeCtx.headers ? { headers: invokeCtx.headers } : {}),
        ...(invokeCtx.remoteAddress !== undefined ? { ip: invokeCtx.remoteAddress } : {}),
      }),
    // Filters only when the transport supplied the caller's request context
    // (the `/mcp` route with `listVisibleOnly`); stdio and direct embeddings
    // list every tool, as before.
    visible: (callCtx) => {
      const caller = callCtx.caller
      return caller !== null && typeof caller === 'object' ? tool.visible(caller as Record<string, unknown>) : true
    },
  }
}

/**
 * What a transport hands `handleMessage`: the tool-facing {@link ToolCallContext}
 * plus the core's transport fields (`session`, `notify`, `elicit`, …).
 */
export type McpCallContext = ToolCallContext & Omit<CallContext, 'headers' | 'signal'>

/** Translate the runtime's `ip` into the core's `remoteAddress`. */
function toCoreContext(callCtx: McpCallContext | undefined): CallContext {
  if (!callCtx) return {}
  const { ip, ...rest } = callCtx
  return { ...rest, ...(ip !== undefined && rest.remoteAddress === undefined ? { remoteAddress: ip } : {}) }
}

/**
 * A Basalt app as an MCP server. Tools are the routes opted in with `meta.mcp`;
 * `handleMessage` implements the MCP JSON-RPC surface, transport-independently,
 * so the HTTP route and the stdio server share one code path.
 *
 * The wire dispatch is delegated to the zero-dependency `@basaltkit/mcp-core`
 * server — this class stays the framework-aware adapter that turns routes into
 * function tools and preserves the package's public surface.
 */
export class McpServer {
  readonly serverInfo: McpServerInfo
  private readonly core: CoreServer

  constructor(options: McpServerOptions) {
    this.serverInfo = options.serverInfo ?? { name: 'basalt', version: '0.1.0' }
    const tools = collectTools(options.routes, options.container, {
      ...(options.filter ? { filter: options.filter } : {}),
      ...(options.forwardHeaders ? { forwardHeaders: options.forwardHeaders } : {}),
    }).map(toToolDef)
    this.core = new CoreServer({ tools, serverInfo: this.serverInfo })
  }

  /** Tool descriptors, as returned by `tools/list`. */
  listTools() {
    return this.core.listTools()
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    callCtx?: ToolCallContext,
  ): Promise<McpToolResult> {
    return this.core.callTool(name, args, toCoreContext(callCtx))
  }

  /**
   * Handle one JSON-RPC message. Returns the response, or `null` for a
   * notification (which by spec gets no reply). `callCtx` may carry per-request
   * `headers`, the caller `ip`, a `session` (scopes cancellation) and, over
   * stdio, `notify`/`elicit` hooks — all forwarded to the core.
   */
  async handleMessage(
    message: JsonRpcRequest,
    callCtx?: McpCallContext,
  ): Promise<JsonRpcResponse | null> {
    return this.core.handleMessage(message, toCoreContext(callCtx))
  }
}

export const MCP = createToken<McpServer>('mcp')

export interface McpPluginOptions {
  /** The routes to scan for `meta.mcp` — typically the same array you pass the adapter. */
  routes: BasaltRoute[]
  serverInfo?: McpServerInfo
  filter?: (route: BasaltRoute) => boolean
  /**
   * Extra request headers a tool call inherits from the `/mcp` request (or the
   * `callTool` headers), on top of `DEFAULT_FORWARDED_HEADERS` — e.g. a
   * custom tenant header. Everything not listed is dropped.
   */
  forwardHeaders?: string[]
}

/**
 * Registers the `MCP` server (built from the opted-in routes) in the container.
 * Pair it with `mcpRoutes()` for the HTTP transport, or `serveMcpStdio()` for
 * stdio. The AI/codegen layer stays dev-only — this is the runtime surface.
 */
export function mcpPlugin(options: McpPluginOptions) {
  return definePlugin({
    name: 'basalt:mcp',
    register({ container }) {
      container.singleton(
        MCP,
        () =>
          new McpServer({
            routes: options.routes,
            container,
            ...(options.serverInfo ? { serverInfo: options.serverInfo } : {}),
            ...(options.filter ? { filter: options.filter } : {}),
            ...(options.forwardHeaders ? { forwardHeaders: options.forwardHeaders } : {}),
          }),
      )
    },
  })
}

export interface McpRoutesOptions {
  /** Endpoint path. Default `/mcp`. */
  path?: string
  /**
   * Rate-limit budget for the `/mcp` endpoint, applied as the route's
   * `meta.rateLimit` (enforced by `securityPlugin` in a dedicated bucket).
   * Recommended for exposed deployments: tool calls are often heavier than
   * plain endpoints. A tool route's OWN `meta.rateLimit` also applies when it
   * is invoked as a tool through `/mcp` (securityPlugin enforces it as a route
   * guard), keyed by the `/mcp` caller's ip, which the tool request inherits.
   */
  rateLimit?: { limit: number; windowMs: number }
  /**
   * Origins (scheme + host + port, e.g. `https://app.example.com`) allowed to
   * call the endpoint from a browser. A request carrying an `Origin` header
   * that is neither same-origin (its host equals the request's `Host`) nor
   * listed is refused with 403 — the MCP Streamable-HTTP spec requires
   * validating `Origin` (anti DNS-rebinding / CSRF). Requests without `Origin`
   * (non-browser MCP clients) are unaffected. `'*'` disables the check.
   */
  allowedOrigins?: readonly string[] | '*'
  /**
   * Require an authenticated caller for the endpoint itself (sets the route's
   * `meta.auth`, enforced by `authPlugin`). Without it `initialize` and
   * `tools/list` are anonymous — tool CALLS still run each route's own guards.
   */
  auth?: boolean
  /** Extra `meta` for the `/mcp` route (e.g. `{ can: 'mcp:use' }`). */
  meta?: Record<string, unknown>
  /**
   * Hide from `tools/list` the tools the caller statically cannot use.
   * Default `true`. Only side-effect-free checks run (never the guards — those
   * consume rate limits and write audit/denial records):
   *
   * - `meta.auth` tools are hidden from a caller with no `ctx().user`
   *   (when `authPlugin` — a guard claiming `auth` — is registered);
   * - any key whose plugin registered a pure visibility check in
   *   `http:route-visibility` — `teamsPlugin` hides `meta.teamRole` tools
   *   from callers who do not hold the role in the current tenant,
   *   `permissionsPlugin` hides `meta.can` tools whose permission(s) the
   *   caller does not hold.
   *
   * NOT filtered (listed, refused on call): every other guarded key —
   * `mfa`, `scopes`, `subscribed`/`feature`, audiences, rate limits and any
   * check made inside a handler. Visibility is never authorization:
   * `tools/call` still runs every guard.
   */
  listVisibleOnly?: boolean
  /**
   * Streamable-HTTP sessions (default: on). A successful `initialize` answers
   * with an `Mcp-Session-Id` header; every later POST must carry it (400
   * without it; 404 for an unknown, expired or foreign one — the client then
   * re-initializes) and `DELETE` with it ends the session. A session is bound
   * to the caller that opened it (`ctx().user` + tenant, or — anonymous — a
   * hash of the `Authorization`/`x-api-key` credentials), so a
   * `notifications/cancelled` in a later POST of the SAME session cancels the
   * call it names, while no other session can. Sessions live in this process's
   * memory: behind several replicas use sticky sessions, or `false` to run
   * stateless (each POST its own session; no cross-POST cancellation).
   */
  sessions?: false | McpSessionOptions
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Same-origin (Origin's host equals the request's Host) or explicitly allowed. */
function originAllowed(request: HttpRequest, allowed: readonly string[] | '*' | undefined): boolean {
  const origin = headerValue(request.headers['origin'])
  if (origin === undefined || allowed === '*') return true
  const normalized = origin.trim().toLowerCase().replace(/\/+$/, '')
  if ((allowed ?? []).some((o) => o.trim().toLowerCase().replace(/\/+$/, '') === normalized)) return true
  const host = headerValue(request.headers['host'])?.trim().toLowerCase()
  try {
    return host !== undefined && new URL(normalized).host === host
  } catch {
    return false // `Origin: null` and other opaque origins are never same-origin
  }
}

/** Exactly `application/json` (parameters such as `charset` allowed) — never a CORS-safelisted type. */
function isJsonContentType(request: HttpRequest): boolean {
  const type = headerValue(request.headers['content-type'])
  return type !== undefined && type.split(';')[0]!.trim().toLowerCase() === 'application/json'
}

/**
 * The identity a session is bound to: the authenticated user (in its tenant),
 * or — without one — the credentials the request presented, hashed.
 */
function principalOf(context: Record<string, unknown>, request: HttpRequest): string {
  const user = context['user'] as { id?: unknown } | undefined
  const tenant = context['tenant'] as { id?: unknown } | undefined
  if (user && (typeof user.id === 'string' || typeof user.id === 'number')) {
    return `user:${JSON.stringify([tenant?.id ?? null, user.id])}`
  }
  const credentials = [headerValue(request.headers['authorization']), headerValue(request.headers['x-api-key'])]
  return `anon:${createHash('sha256').update(JSON.stringify(credentials)).digest('base64url')}`
}

/**
 * The MCP HTTP transport as a neutral `route()` — POST JSON-RPC to `/mcp`. It
 * runs on the Fastify, Express and Hono adapters unchanged. Credential and
 * tenant headers (see `DEFAULT_FORWARDED_HEADERS`) and the client ip are
 * propagated into each tool call, so tools honour the same tenancy, auth and
 * rate limits as a direct HTTP request.
 *
 * Browser-facing hardening: a foreign `Origin` gets 403 (see
 * `allowedOrigins`) and the body must be sent as `application/json` (415
 * otherwise), so a cross-site "simple" request can never drive a tool with the
 * visitor's cookies. JSON-RPC batches are accepted. Sessions (`sessions`,
 * default on) let a `notifications/cancelled` in a later POST of the same
 * session cancel a call; `tools/list` hides the tools the caller cannot use
 * (`listVisibleOnly`, default on). With sessions on, a `DELETE` route on the
 * same path ends a session.
 */
export function mcpRoutes(options: McpRoutesOptions = {}): BasaltRoute[] {
  const path = options.path ?? '/mcp'
  const meta: Record<string, unknown> = {
    ...options.meta,
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.auth ? { auth: true } : {}),
  }
  const listVisibleOnly = options.listVisibleOnly !== false
  const sessions = options.sessions === false ? undefined : new McpSessions(options.sessions ?? {})
  const routeMeta = Object.keys(meta).length > 0 ? { meta } : {}
  const assertOrigin = (request: HttpRequest): void => {
    if (!originAllowed(request, options.allowedOrigins)) {
      throw new HttpError(403, 'MCP_ORIGIN_FORBIDDEN', 'Origin not allowed')
    }
  }

  const routes: BasaltRoute[] = [
    route({
      method: 'POST',
      url: path,
      body: z.unknown(),
      ...routeMeta,
      async handler({ request, reply }) {
        assertOrigin(request)
        if (!isJsonContentType(request)) {
          return reply
            .code(415)
            .send(fail(null, RPC_ERRORS.INVALID_REQUEST, 'Content-Type must be application/json'))
        }
        const context = ctx() as Record<string, unknown>
        const server = (context['container'] as Container).get(MCP)

        // The cancellation scope: the session (shared by all its POSTs) or —
        // stateless — this request alone.
        let session: object = {}
        let issued: string | undefined
        const principal = sessions ? principalOf(context, request) : ''
        if (sessions) {
          if (isInitializeRequest(request.body)) {
            const opened = sessions.create(principal)
            session = opened
            issued = opened.id
          } else {
            const id = headerValue(request.headers[MCP_SESSION_HEADER])
            if (id === undefined) {
              return reply
                .code(400)
                .send(fail(null, RPC_ERRORS.INVALID_REQUEST, 'Bad Request: Mcp-Session-Id header required (send initialize first)'))
            }
            const found = sessions.resolve(id, principal)
            if (!found) {
              return reply
                .code(404)
                .send(fail(null, RPC_ERRORS.INVALID_REQUEST, 'Session not found (expired or unknown) — initialize again'))
            }
            session = found
          }
        }

        const response = await dispatchPayload(server, request.body, {
          headers: request.headers,
          session,
          ...(request.ip !== undefined ? { remoteAddress: request.ip } : {}),
          ...(listVisibleOnly ? { caller: context } : {}),
        })
        // A failed initialize opens nothing.
        if (issued !== undefined && (response === null || Array.isArray(response) || response.error !== undefined)) {
          sessions!.delete(issued, principal)
          issued = undefined
        }
        if (issued !== undefined) reply.header(MCP_SESSION_HEADER, issued)
        if (response === null) return reply.code(202).send()
        return response
      },
    }),
  ]
  if (sessions) {
    routes.push(
      route({
        method: 'DELETE',
        url: path,
        ...routeMeta,
        handler({ request, reply }) {
          assertOrigin(request)
          const principal = principalOf(ctx() as Record<string, unknown>, request)
          if (!sessions.delete(headerValue(request.headers[MCP_SESSION_HEADER]), principal)) {
            return reply.code(404).send(fail(null, RPC_ERRORS.INVALID_REQUEST, 'Session not found'))
          }
          return reply.code(204).send()
        },
      }),
    )
  }
  return routes
}
