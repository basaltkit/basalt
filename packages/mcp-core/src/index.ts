// Wire protocol — JSON-RPC 2.0 + MCP types and helpers.
export {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  RPC_ERRORS,
  ok,
  fail,
  isNotification,
  negotiateVersion,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type JsonRpcId,
  type McpContent,
  type McpToolResult,
} from './protocol.js'

// Transport-neutral server over function-shaped tools/resources/prompts.
export {
  McpServer,
  type McpServerInfo,
  type McpServerOptions,
  type CallContext,
  type ProgressUpdate,
  type ToolInvokeContext,
  type McpToolDef,
  type ResourceReadContext,
  type McpResourceContents,
  type McpResourceDef,
  type McpPromptArgument,
  type McpPromptMessage,
  type McpPromptResult,
  type McpPromptDef,
} from './server.js'

// Stdio transport.
export {
  serveStdio,
  type StdioServerLike,
  type ServeStdioOptions,
  type StdioHandle,
} from './stdio.js'
