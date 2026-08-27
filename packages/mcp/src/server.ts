import { createToken, ctx, definePlugin, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import {
  McpServer as CoreServer,
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
}

/** Adapt a route-backed {@link McpTool} to the core's function-shaped {@link McpToolDef}. */
function toToolDef(tool: McpTool): McpToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    invoke: (args, invokeCtx) =>
      tool.invoke(args, invokeCtx.headers ? { headers: invokeCtx.headers } : {}),
  }
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
    const filterOpt = options.filter ? { filter: options.filter } : {}
    const tools = collectTools(options.routes, options.container, filterOpt).map(toToolDef)
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
    return this.core.callTool(name, args, (callCtx ?? {}) as CallContext)
  }

  /**
   * Handle one JSON-RPC message. Returns the response, or `null` for a
   * notification (which by spec gets no reply). `callCtx` may carry per-request
   * `headers` (and, over stdio, a `notify` hook) — both forwarded to the core.
   */
  async handleMessage(
    message: JsonRpcRequest,
    callCtx?: ToolCallContext,
  ): Promise<JsonRpcResponse | null> {
    return this.core.handleMessage(message, (callCtx ?? {}) as CallContext)
  }
}

export const MCP = createToken<McpServer>('mcp')

export interface McpPluginOptions {
  /** The routes to scan for `meta.mcp` — typically the same array you pass the adapter. */
  routes: BasaltRoute[]
  serverInfo?: McpServerInfo
  filter?: (route: BasaltRoute) => boolean
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
          }),
      )
    },
  })
}

export interface McpRoutesOptions {
  /** Endpoint path. Default `/mcp`. */
  path?: string
}

/**
 * The MCP HTTP transport as a neutral `route()` — POST JSON-RPC to `/mcp`. It
 * runs on the Fastify, Express and Hono adapters unchanged. Request headers
 * (tenant, authorization) are propagated into each tool call, so tools honour
 * the same tenancy and auth as a direct HTTP request.
 */
export function mcpRoutes(options: McpRoutesOptions = {}): BasaltRoute[] {
  const path = options.path ?? '/mcp'
  return [
    route({
      method: 'POST',
      url: path,
      body: z.unknown(),
      async handler({ request, reply }) {
        const server = (ctx().container as Container).get(MCP)
        const response = await server.handleMessage(request.body as JsonRpcRequest, {
          headers: request.headers,
        })
        if (response === null) return reply.code(202).send()
        return response
      },
    }),
  ]
}
