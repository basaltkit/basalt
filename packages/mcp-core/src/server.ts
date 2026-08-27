import {
  fail,
  isNotification,
  negotiateVersion,
  ok,
  RPC_ERRORS,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolResult,
} from './protocol.js'

// --- Progress + cancellation ------------------------------------------------

/** A progress report emitted during a long-running tool call (spec: `notifications/progress`). */
export interface ProgressUpdate {
  /** Work done so far. */
  progress?: number
  /** Total work, when known. */
  total?: number
  /** Human-readable status. */
  message?: string
}

// --- Tools ------------------------------------------------------------------

/**
 * Per-invocation context handed to a tool. `signal` aborts on client
 * cancellation; `progress` streams updates back to the client; `elicit` asks the
 * client a yes/no question (when the client supports elicitation); `headers`
 * carries opaque per-call transport metadata (e.g. HTTP headers) forwarded verbatim.
 */
export interface ToolInvokeContext {
  signal: AbortSignal
  progress?: (update: ProgressUpdate) => void
  elicit?: (prompt: string) => Promise<boolean>
  headers?: Record<string, string | string[] | undefined>
}

/**
 * A function-shaped MCP tool. Unlike the runtime `@basaltkit/mcp` package (whose
 * tools are `BasaltRoute`s), the core takes plain descriptors so a dev tool can
 * expose any function — no DI container, no framework runtime.
 */
export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  invoke(args: Record<string, unknown>, ctx: ToolInvokeContext): Promise<McpToolResult>
}

// --- Resources --------------------------------------------------------------

export interface ResourceReadContext {
  signal: AbortSignal
}

export interface McpResourceContents {
  /** Defaults to the resource's own `uri`. */
  uri?: string
  mimeType?: string
  text: string
}

export interface McpResourceDef {
  uri: string
  name: string
  description?: string
  mimeType?: string
  read(ctx: ResourceReadContext): Promise<McpResourceContents> | McpResourceContents
}

// --- Prompts ----------------------------------------------------------------

export interface McpPromptArgument {
  name: string
  description?: string
  required?: boolean
}

export interface McpPromptMessage {
  role: 'user' | 'assistant'
  content: { type: 'text'; text: string }
}

export interface McpPromptResult {
  description?: string
  messages: McpPromptMessage[]
}

export interface McpPromptDef {
  name: string
  description?: string
  arguments?: McpPromptArgument[]
  get(args: Record<string, string>): Promise<McpPromptResult> | McpPromptResult
}

// --- Server -----------------------------------------------------------------

export interface McpServerInfo {
  name: string
  version: string
}

/**
 * Per-call context supplied by the transport. `headers` is forwarded to tools;
 * `progress`/`elicit` are optional client capabilities; `notify` lets the
 * dispatcher push server→client notifications (progress) back over the transport;
 * `signal` links an external abort into per-request cancellation.
 */
export interface CallContext {
  headers?: Record<string, string | string[] | undefined>
  progress?: (update: ProgressUpdate) => void
  elicit?: (prompt: string) => Promise<boolean>
  notify?: (message: JsonRpcRequest) => void
  signal?: AbortSignal
}

export interface McpServerOptions {
  tools?: McpToolDef[]
  resources?: McpResourceDef[]
  prompts?: McpPromptDef[]
  serverInfo?: McpServerInfo
}

const DEFAULT_SERVER_INFO: McpServerInfo = { name: 'basalt-mcp-core', version: '0.1.0' }

/** Link an external abort signal into a per-request controller. */
function linkSignal(external: AbortSignal | undefined, controller: AbortController): void {
  if (!external) return
  if (external.aborted) {
    controller.abort()
    return
  }
  external.addEventListener('abort', () => controller.abort(), { once: true })
}

/**
 * A transport-neutral MCP server over function-shaped tools/resources/prompts.
 * `handleMessage` implements the MCP JSON-RPC surface independently of any
 * transport, so stdio and HTTP share one code path. Resources and prompts are
 * only served (and advertised in `initialize` capabilities) when registered, so a
 * tools-only server behaves exactly like a classic MCP tool server.
 */
export class McpServer {
  readonly serverInfo: McpServerInfo
  private readonly tools: Map<string, McpToolDef>
  private readonly resources: Map<string, McpResourceDef>
  private readonly prompts: Map<string, McpPromptDef>
  /** In-flight tool calls keyed by request id — the target of `notifications/cancelled`. */
  private readonly inflight = new Map<JsonRpcId, AbortController>()

  constructor(options: McpServerOptions = {}) {
    this.serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO
    this.tools = new Map((options.tools ?? []).map((t) => [t.name, t]))
    this.resources = new Map((options.resources ?? []).map((r) => [r.uri, r]))
    this.prompts = new Map((options.prompts ?? []).map((p) => [p.name, p]))
  }

  /** Tool descriptors, as returned by `tools/list`. */
  listTools() {
    return [...this.tools.values()].map(({ name, description, inputSchema, outputSchema }) => ({
      name,
      description,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
    }))
  }

  /** Invoke a tool directly (bypassing the JSON-RPC layer). Throws for an unknown name. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: CallContext = {},
  ): Promise<McpToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const controller = new AbortController()
    linkSignal(ctx.signal, controller)
    return tool.invoke(args ?? {}, this.invokeContext(controller, ctx, undefined))
  }

  /**
   * Handle one JSON-RPC message. Returns the response, or `null` for a
   * notification (which by spec gets no reply).
   */
  async handleMessage(
    message: JsonRpcRequest,
    ctx: CallContext = {},
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
            capabilities: this.capabilities(),
            serverInfo: this.serverInfo,
          })
        }
        case 'notifications/initialized':
          return null
        case 'notifications/cancelled': {
          const params = (message.params ?? {}) as { requestId?: JsonRpcId }
          if (params.requestId !== undefined && params.requestId !== null) {
            this.inflight.get(params.requestId)?.abort()
          }
          return null
        }
        case 'ping':
          return ok(id, {})
        case 'tools/list':
          return ok(id, { tools: this.listTools() })
        case 'tools/call':
          return await this.dispatchToolCall(id, message, ctx)
        case 'resources/list':
          return this.resources.size > 0
            ? ok(id, { resources: this.listResources() })
            : this.unknownMethod(id, notification, message.method)
        case 'resources/read':
          return this.resources.size > 0
            ? await this.dispatchResourceRead(id, message)
            : this.unknownMethod(id, notification, message.method)
        case 'prompts/list':
          return this.prompts.size > 0
            ? ok(id, { prompts: this.listPrompts() })
            : this.unknownMethod(id, notification, message.method)
        case 'prompts/get':
          return this.prompts.size > 0
            ? await this.dispatchPromptGet(id, message)
            : this.unknownMethod(id, notification, message.method)
        default:
          return this.unknownMethod(id, notification, message.method)
      }
    } catch (error) {
      if (notification) return null
      const messageText = error instanceof Error ? error.message : 'Internal error'
      return fail(id, RPC_ERRORS.INTERNAL_ERROR, messageText)
    }
  }

  private unknownMethod(id: JsonRpcId, notification: boolean, method: string): JsonRpcResponse | null {
    if (notification) return null
    return fail(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`)
  }

  private capabilities(): Record<string, unknown> {
    const caps: Record<string, unknown> = { tools: { listChanged: false } }
    if (this.resources.size > 0) caps['resources'] = { listChanged: false }
    if (this.prompts.size > 0) caps['prompts'] = { listChanged: false }
    return caps
  }

  private async dispatchToolCall(
    id: JsonRpcId,
    message: JsonRpcRequest,
    ctx: CallContext,
  ): Promise<JsonRpcResponse> {
    const params = (message.params ?? {}) as {
      name?: unknown
      arguments?: unknown
      _meta?: { progressToken?: unknown }
    }
    if (typeof params.name !== 'string') {
      return fail(id, RPC_ERRORS.INVALID_PARAMS, 'tools/call requires a string `name`')
    }
    const tool = this.tools.get(params.name)
    if (!tool) {
      return fail(id, RPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${params.name}`)
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>
    const controller = new AbortController()
    linkSignal(ctx.signal, controller)
    // Per-request cancellation: register so `notifications/cancelled` can abort it.
    if (id !== null) this.inflight.set(id, controller)
    try {
      const result = await tool.invoke(
        args,
        this.invokeContext(controller, ctx, params._meta?.progressToken),
      )
      return ok(id, result)
    } finally {
      if (id !== null) this.inflight.delete(id)
    }
  }

  private async dispatchResourceRead(
    id: JsonRpcId,
    message: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const params = (message.params ?? {}) as { uri?: unknown }
    if (typeof params.uri !== 'string') {
      return fail(id, RPC_ERRORS.INVALID_PARAMS, 'resources/read requires a string `uri`')
    }
    const resource = this.resources.get(params.uri)
    if (!resource) {
      return fail(id, RPC_ERRORS.INVALID_PARAMS, `Unknown resource: ${params.uri}`)
    }
    const controller = new AbortController()
    const contents = await resource.read({ signal: controller.signal })
    const mimeType = contents.mimeType ?? resource.mimeType
    return ok(id, {
      contents: [
        {
          uri: contents.uri ?? resource.uri,
          ...(mimeType ? { mimeType } : {}),
          text: contents.text,
        },
      ],
    })
  }

  private async dispatchPromptGet(
    id: JsonRpcId,
    message: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
    if (typeof params.name !== 'string') {
      return fail(id, RPC_ERRORS.INVALID_PARAMS, 'prompts/get requires a string `name`')
    }
    const prompt = this.prompts.get(params.name)
    if (!prompt) {
      return fail(id, RPC_ERRORS.INVALID_PARAMS, `Unknown prompt: ${params.name}`)
    }
    const args = (params.arguments ?? {}) as Record<string, string>
    return ok(id, await prompt.get(args))
  }

  private listResources() {
    return [...this.resources.values()].map(({ uri, name, description, mimeType }) => ({
      uri,
      name,
      ...(description ? { description } : {}),
      ...(mimeType ? { mimeType } : {}),
    }))
  }

  private listPrompts() {
    return [...this.prompts.values()].map(({ name, description, arguments: args }) => ({
      name,
      ...(description ? { description } : {}),
      ...(args ? { arguments: args } : {}),
    }))
  }

  /** Build the per-invocation context: signal, plus progress/elicit when available. */
  private invokeContext(
    controller: AbortController,
    ctx: CallContext,
    progressToken: unknown,
  ): ToolInvokeContext {
    const invoke: ToolInvokeContext = { signal: controller.signal }
    if (ctx.headers) invoke.headers = ctx.headers
    if (ctx.elicit) invoke.elicit = ctx.elicit
    // Prefer an explicit progress callback; otherwise synthesize one from the
    // client's progressToken + the transport's notify (full emission lands in M2,
    // but the plumbing is live here so it's purely additive).
    const progress = ctx.progress ?? progressFromToken(progressToken, ctx.notify)
    if (progress) invoke.progress = progress
    return invoke
  }
}

function progressFromToken(
  token: unknown,
  notify: ((message: JsonRpcRequest) => void) | undefined,
): ((update: ProgressUpdate) => void) | undefined {
  if (token === undefined || token === null || !notify) return undefined
  return (update: ProgressUpdate) => {
    notify({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, ...update },
    })
  }
}
