import { createToken, definePlugin } from '@basaltkit/core'
import {
  HttpClientTransport,
  McpClient,
  StdioClientTransport,
  type McpClientInfo,
  type McpClientTransport,
} from './client.js'
import type { McpToolResult } from './protocol.js'

/** How to reach one external MCP server. */
export type McpServerConnection =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }

function transportFor(connection: McpServerConnection): McpClientTransport {
  if (connection.type === 'stdio') {
    return new StdioClientTransport({
      command: connection.command,
      ...(connection.args ? { args: connection.args } : {}),
      ...(connection.env ? { env: connection.env } : {}),
      ...(connection.cwd ? { cwd: connection.cwd } : {}),
    })
  }
  return new HttpClientTransport(connection.url, connection.headers ? { headers: connection.headers } : {})
}

/**
 * A registry of named MCP clients — the runtime "client" side. Connections are
 * lazy-safe: `connect(name)` is idempotent, so `callTool`/`listTools` work
 * whether or not the plugin connected eagerly at boot.
 */
export class McpClients {
  private readonly clients = new Map<string, McpClient>()
  private readonly connected = new Set<string>()

  constructor(connections: Record<string, McpServerConnection>, clientInfo?: McpClientInfo) {
    for (const [name, connection] of Object.entries(connections)) {
      this.clients.set(name, new McpClient(transportFor(connection), clientInfo))
    }
  }

  names(): string[] {
    return [...this.clients.keys()]
  }

  has(name: string): boolean {
    return this.clients.has(name)
  }

  /** The raw client for a server. Throws for an unknown name. */
  get(name: string): McpClient {
    const client = this.clients.get(name)
    if (!client) throw new Error(`Unknown MCP server: ${name}`)
    return client
  }

  /** Connect one server if not already connected (idempotent). */
  async connect(name: string): Promise<void> {
    if (this.connected.has(name)) return
    await this.get(name).connect()
    this.connected.add(name)
  }

  async connectAll(): Promise<void> {
    await Promise.all(this.names().map((name) => this.connect(name)))
  }

  async listTools(name: string) {
    await this.connect(name)
    return this.get(name).listTools()
  }

  async callTool(name: string, tool: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    await this.connect(name)
    return this.get(name).callTool(tool, args)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()))
    this.connected.clear()
  }
}

export const MCP_CLIENTS = createToken<McpClients>('mcp:clients')

export interface McpClientPluginOptions {
  /** Named external MCP servers to make available in the container. */
  servers: Record<string, McpServerConnection>
  /** Connect at boot (default). Set `false` to connect lazily on first use. */
  eager?: boolean
  clientInfo?: McpClientInfo
}

/**
 * Registers a `MCP_CLIENTS` registry of external MCP servers. Resolve the token
 * and call `callTool(server, tool, args)` / `listTools(server)` to use their
 * tools from anywhere in the app. Connects eagerly at boot and closes every
 * client on shutdown.
 *
 * ```ts
 * mcpClientPlugin({
 *   servers: {
 *     search: { type: 'http', url: 'https://search.example/mcp' },
 *     files:  { type: 'stdio', command: 'mcp-files', args: ['--root', '.'] },
 *   },
 * })
 * // later:  await container.get(MCP_CLIENTS).callTool('search', 'query', { q: 'basalt' })
 * ```
 */
export function mcpClientPlugin(options: McpClientPluginOptions) {
  return definePlugin({
    name: 'basalt:mcp-client',
    register({ container }) {
      container.singleton(MCP_CLIENTS, () => new McpClients(options.servers, options.clientInfo))
    },
    async boot({ container }) {
      if (options.eager !== false) await container.get(MCP_CLIENTS).connectAll()
    },
    async shutdown({ container }) {
      await container.get(MCP_CLIENTS).closeAll()
    },
  })
}
