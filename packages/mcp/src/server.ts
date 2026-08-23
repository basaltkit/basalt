import { createToken, ctx, definePlugin, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { collectTools, type McpTool, type ToolCallContext } from './tools.js'
import {
  fail,
  isNotification,
  negotiateVersion,
  ok,
  RPC_ERRORS,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.js'

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

/**
 * A Basalt app as an MCP server. Tools are the routes opted in with `meta.mcp`;
 * `handleMessage` implements the MCP JSON-RPC surface, transport-independently,
 * so the HTTP route and the stdio server share one code path.
 */
export class McpServer {
  readonly serverInfo: McpServerInfo
  private readonly tools: Map<string, McpTool>

  constructor(options: McpServerOptions) {
    this.serverInfo = options.serverInfo ?? { name: 'basalt', version: '0.1.0' }
    const filterOpt = options.filter ? { filter: options.filter } : {}
    this.tools = new Map(
      collectTools(options.routes, options.container, filterOpt).map((tool) => [tool.name, tool]),
    )
  }

  /** Tool descriptors, as returned by `tools/list`. */
  listTools() {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>, ctx?: ToolCallContext) {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.invoke(args, ctx)
  }

  /**
   * Handle one JSON-RPC message. Returns the response, or `null` for a
   * notification (which by spec gets no reply).
   */
  async handleMessage(
    message: JsonRpcRequest,
    callCtx?: ToolCallContext,
  ): Promise<JsonRpcResponse | null> {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return fail(message?.id ?? null, RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC request')
    }
    const notification = isNotification(message)
    const id = message.id ?? null

    try {
      switch (message.method) {
        case 'initialize': {
          const params = (message.params ?? {}) as { protocolVersion?: unknown }
          return ok(id, {
            protocolVersion: negotiateVersion(params.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.serverInfo,
          })
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null // notifications: no response
        case 'ping':
          return ok(id, {})
        case 'tools/list':
          return ok(id, { tools: this.listTools() })
        case 'tools/call': {
          const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
          if (typeof params.name !== 'string') {
            return fail(id, RPC_ERRORS.INVALID_PARAMS, 'tools/call requires a string `name`')
          }
          if (!this.tools.has(params.name)) {
            return fail(id, RPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${params.name}`)
          }
          const args = (params.arguments ?? {}) as Record<string, unknown>
          const result = await this.callTool(params.name, args, callCtx)
          return ok(id, result)
        }
        default:
          if (notification) return null
          return fail(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${message.method}`)
      }
    } catch (error) {
      if (notification) return null
      const messageText = error instanceof Error ? error.message : 'Internal error'
      return fail(id, RPC_ERRORS.INTERNAL_ERROR, messageText)
    }
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
