/**
 * The JSON-RPC 2.0 + MCP wire protocol now lives in the zero-dependency
 * `@basaltkit/mcp-core` package, so the runtime server here and the dev-only AI
 * bridge share one implementation. This module re-exports the same names to keep
 * `@basaltkit/mcp`'s public surface byte-identical.
 */
export {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  RPC_ERRORS,
  ok,
  fail,
  isNotification,
  negotiateVersion,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcError,
  type JsonRpcResponse,
  type McpContent,
  type McpToolResult,
} from '@basaltkit/mcp-core'
