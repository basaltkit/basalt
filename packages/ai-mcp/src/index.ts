// Programmatic entry — for tests and embedding. An application's *runtime* must
// never import this package; it is a dev-only MCP bridge, consumed as the
// `basalt-ai-mcp` bin.
export {
  buildAiMcpServer,
  createAiMcpServer,
  AI_MCP_VERSION,
  type AiMcpOptions,
  type StartOptions,
} from './server.js'
export {
  createSession,
  resolveWorkspaceRoot,
  type Session,
  type SessionOptions,
} from './session.js'
