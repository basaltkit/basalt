import { createToken, ctx, definePlugin, type Container } from '@basaltkit/core'
import { HttpError, route, type BasaltRoute, type HttpRequest } from '@basaltkit/http'
import { z } from 'zod'
import {
  dispatchPayload,
  McpServer as CoreServer,
  RPC_ERRORS,
  fail,
  type CallContext,
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
 * The MCP HTTP transport as a neutral `route()` — POST JSON-RPC to `/mcp`. It
 * runs on the Fastify, Express and Hono adapters unchanged. Credential and
 * tenant headers (see `DEFAULT_FORWARDED_HEADERS`) and the client ip are
 * propagated into each tool call, so tools honour the same tenancy, auth and
 * rate limits as a direct HTTP request.
 *
 * Browser-facing hardening: a foreign `Origin` gets 403 (see
 * `allowedOrigins`) and the body must be sent as `application/json` (415
 * otherwise), so a cross-site "simple" request can never drive a tool with the
 * visitor's cookies. JSON-RPC batches are accepted. Each POST is its own MCP
 * session: a `notifications/cancelled` sent in a later POST does not reach it.
 */
export function mcpRoutes(options: McpRoutesOptions = {}): BasaltRoute[] {
  const path = options.path ?? '/mcp'
  const meta: Record<string, unknown> = {
    ...options.meta,
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.auth ? { auth: true } : {}),
  }
  return [
    route({
      method: 'POST',
      url: path,
      body: z.unknown(),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      async handler({ request, reply }) {
        if (!originAllowed(request, options.allowedOrigins)) {
          throw new HttpError(403, 'MCP_ORIGIN_FORBIDDEN', 'Origin not allowed')
        }
        if (!isJsonContentType(request)) {
          return reply
            .code(415)
            .send(fail(null, RPC_ERRORS.INVALID_REQUEST, 'Content-Type must be application/json'))
        }
        const server = (ctx().container as Container).get(MCP)
        const response = await dispatchPayload(server, request.body, {
          headers: request.headers,
          session: {},
          ...(request.ip !== undefined ? { remoteAddress: request.ip } : {}),
        })
        if (response === null) return reply.code(202).send()
        return response
      },
    }),
  ]
}
