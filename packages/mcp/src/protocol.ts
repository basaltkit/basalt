/**
 * Minimal JSON-RPC 2.0 + Model Context Protocol wire types. Basalt speaks MCP
 * directly (no SDK dependency) so the same message handler drives both the
 * neutral HTTP route and the stdio transport. The methods implemented are the
 * stable core: `initialize`, `tools/list`, `tools/call` and `ping`.
 */

/** Protocol revisions this server understands, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

/** Standard JSON-RPC error codes. */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

/** A single piece of tool output — text is the universally-supported kind. */
export interface McpContent {
  type: 'text'
  text: string
}

/** The result of a `tools/call`. */
export interface McpToolResult {
  content: McpContent[]
  /** Structured mirror of the content, when the tool returned JSON. */
  structuredContent?: unknown
  /** True when the tool failed — the error travels in `content`, not as a protocol error. */
  isError?: boolean
}

export function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

/** A request with no `id` is a notification — it never gets a response. */
export function isNotification(message: JsonRpcRequest): boolean {
  return message.id === undefined
}

/** Negotiate a protocol version: honour the client's if we support it, else offer our latest. */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION
}
