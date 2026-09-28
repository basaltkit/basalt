export {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  RPC_ERRORS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type JsonRpcId,
  type McpContent,
  type McpToolResult,
} from './protocol.js'

export { MCP_SESSION_HEADER, type McpSessionOptions } from '@basaltkit/mcp-core'

export {
  collectTools,
  defaultToolName,
  toolSignal,
  DEFAULT_FORWARDED_HEADERS,
  type McpTool,
  type ToolCallContext,
} from './tools.js'

export {
  McpServer,
  MCP,
  mcpPlugin,
  mcpRoutes,
  type McpServerInfo,
  type McpServerOptions,
  type McpPluginOptions,
  type McpRoutesOptions,
  type McpCallContext,
} from './server.js'

export {
  serveMcpStdio,
  type McpStdioOptions,
  type McpStdioHandle,
} from './stdio.js'

export {
  McpClient,
  HttpClientTransport,
  StdioClientTransport,
  DEFAULT_INHERITED_ENV,
  buildStdioEnv,
  type McpClientTransport,
  type McpClientInfo,
  type StdioTransportOptions,
} from './client.js'

export {
  mcpClientPlugin,
  McpClients,
  MCP_CLIENTS,
  type McpClientPluginOptions,
  type McpServerConnection,
} from './client-plugin.js'
