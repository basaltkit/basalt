// Programmatic entry — for tests and embedding. An application's *runtime* must
// never import this package; it is a dev-only MCP bridge, consumed as the
// `basalt-ai-mcp` bin.
export {
  buildAiMcpServer,
  createAiMcpServer,
  createAiMcpHttpServer,
  bearerAuthorizer,
  AI_MCP_VERSION,
  type AiMcpOptions,
  type StartOptions,
  type HttpStartOptions,
} from './server.js'
export { assertDevOnly, AiMcpProductionError, ALLOW_PRODUCTION_ENV } from './guard.js'
export { WorkspaceEscapeError } from './safety.js'
export {
  createSession,
  resolveWorkspaceRoot,
  type Session,
  type SessionOptions,
} from './session.js'
