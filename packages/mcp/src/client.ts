import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import {
  LATEST_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolResult,
} from './protocol.js'

/** A duplex JSON-RPC channel to an MCP server. `send` resolves `null` for notifications. */
export interface McpClientTransport {
  send(message: JsonRpcRequest): Promise<JsonRpcResponse | null>
  close(): Promise<void>
}

/** Talk to a remote MCP server over HTTP (the Streamable-HTTP JSON path). */
export class HttpClientTransport implements McpClientTransport {
  constructor(
    private readonly url: string,
    private readonly options: { headers?: Record<string, string> } = {},
  ) {}

  async send(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...this.options.headers },
      body: JSON.stringify(message),
    })
    if (response.status === 202) return null
    const text = await response.text()
    return text ? (JSON.parse(text) as JsonRpcResponse) : null
  }

  async close(): Promise<void> {}
}

export interface StdioTransportOptions {
  command: string
  args?: string[]
  /** Variables passed to the child verbatim (on top of the inherited ones). */
  env?: Record<string, string>
  cwd?: string
  /**
   * Which host environment variables the child inherits. Default: only the
   * non-secret basics in {@link DEFAULT_INHERITED_ENV} (PATH, HOME, locale…),
   * so host secrets (APP_SECRET, DATABASE_URL, provider keys) never reach a
   * third-party server. Pass a list to inherit extra named variables, or
   * `true` to explicitly opt in to the full `process.env`.
   */
  inheritEnv?: boolean | string[]
}

/**
 * Host environment variables a spawned stdio MCP server inherits by default:
 * what a process needs to locate binaries, its home/temp dirs and locale — no
 * application secrets.
 */
export const DEFAULT_INHERITED_ENV: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // Windows
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'PROGRAMFILES',
  'PROGRAMDATA',
])

/**
 * Build the environment for a spawned stdio MCP server: the allowlisted host
 * variables (or all of them with `inheritEnv: true`) plus the explicit `env`.
 */
export function buildStdioEnv(
  options: Pick<StdioTransportOptions, 'env' | 'inheritEnv'>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const inherited: Record<string, string> = {}
  if (options.inheritEnv === true) {
    for (const [key, value] of Object.entries(hostEnv)) if (value !== undefined) inherited[key] = value
  } else {
    // Env var names are case-insensitive on Windows (e.g. `Path`, `SystemRoot`).
    const allowed = new Set(
      [...DEFAULT_INHERITED_ENV, ...(Array.isArray(options.inheritEnv) ? options.inheritEnv : [])].map((k) =>
        k.toUpperCase(),
      ),
    )
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value !== undefined && allowed.has(key.toUpperCase())) inherited[key] = value
    }
  }
  return { ...inherited, ...options.env }
}

/** Spawn a child MCP server and speak newline-delimited JSON-RPC over its stdio. */
export class StdioClientTransport implements McpClientTransport {
  private child: ChildProcessByStdio<Writable, Readable, null> | undefined
  private buffer = ''
  private readonly pending = new Map<
    string | number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >()

  constructor(private readonly options: StdioTransportOptions) {}

  private start(): ChildProcessByStdio<Writable, Readable, null> {
    if (this.child) return this.child
    const child = spawn(this.options.command, this.options.args ?? [], {
      env: buildStdioEnv(this.options),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child = child
    return child
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: JsonRpcResponse
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === null || message.id === undefined) continue
      const waiter = this.pending.get(message.id)
      if (waiter) {
        this.pending.delete(message.id)
        waiter.resolve(message)
      }
    }
  }

  async send(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const child = this.start()
    child.stdin.write(`${JSON.stringify(message)}\n`)
    if (message.id === null || message.id === undefined) return null
    const id = message.id
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  async close(): Promise<void> {
    this.child?.stdin.end()
    this.child?.kill()
    this.child = undefined
  }
}

export interface McpClientInfo {
  name: string
  version: string
}

/**
 * A client for a remote MCP server — the runtime side of "server + client".
 * Point it at a transport, `connect()`, then `listTools()` / `callTool()`.
 *
 * ```ts
 * const client = new McpClient(new HttpClientTransport('https://host/mcp'))
 * await client.connect()
 * const { tools } = await client.listTools()
 * const result = await client.callTool('get_projects', {})
 * ```
 */
export class McpClient {
  private seq = 0

  constructor(
    private readonly transport: McpClientTransport,
    private readonly clientInfo: McpClientInfo = { name: 'basalt-client', version: '0.1.0' },
  ) {}

  async connect(): Promise<{ protocolVersion: string; serverInfo: McpClientInfo }> {
    const result = (await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    })) as { protocolVersion: string; serverInfo: McpClientInfo }
    await this.notify('notifications/initialized')
    return result
  }

  async listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }> {
    return (await this.request('tools/list', {})) as {
      tools: Array<{ name: string; description?: string; inputSchema: unknown }>
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    return (await this.request('tools/call', { name, arguments: args })) as McpToolResult
  }

  async close(): Promise<void> {
    await this.transport.close()
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    const response = await this.transport.send({ jsonrpc: '2.0', id, method, params })
    if (!response) throw new Error(`No response for ${method}`)
    if (response.error) throw new Error(`MCP error ${response.error.code}: ${response.error.message}`)
    return response.result
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.transport.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }
}
