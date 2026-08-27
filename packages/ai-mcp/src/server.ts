import {
  McpServer,
  serveHttp,
  serveStdio,
  type HttpHandle,
  type ServeHttpOptions,
  type ServeStdioOptions,
  type StdioHandle,
} from '@basaltkit/mcp-core'
import { createSession, type SessionOptions } from './session.js'
import { analyzeTool } from './tools/analyze.js'
import { doctorTool } from './tools/doctor.js'
import { planTool } from './tools/plan.js'
import { reviewTool } from './tools/review.js'
import { makeTool } from './tools/make.js'
import { projectResources } from './resources/project.js'
import { knowledgeResources } from './resources/knowledge.js'
import { workflowPrompts } from './prompts/workflows.js'

export const AI_MCP_VERSION = '0.1.0'
const SERVER_INFO = { name: 'basalt-ai-mcp', version: AI_MCP_VERSION }

export type AiMcpOptions = SessionOptions

/**
 * Build the read-only AI MCP server: the `basalt_analyze` / `basalt_doctor`
 * tools plus the `basalt://project/*` and `basalt://knowledge/*` resources,
 * wired into a generic `@basaltkit/mcp-core` server. Programmatic entry for
 * tests and the bin — never imported by an application's runtime.
 */
export function buildAiMcpServer(options: AiMcpOptions = {}): McpServer {
  const session = createSession(options)
  return new McpServer({
    tools: [analyzeTool(session), doctorTool(session), planTool(session), reviewTool(session), makeTool(session)],
    resources: [...projectResources(session), ...knowledgeResources()],
    prompts: workflowPrompts(),
    serverInfo: SERVER_INFO,
  })
}

export interface StartOptions extends AiMcpOptions {
  input?: NodeJS.ReadableStream
  output?: { write(chunk: string): unknown }
}

/**
 * Build the server and start serving over stdio. Returns the transport handle
 * (`close()` detaches the stdin listener).
 */
export function createAiMcpServer(options: StartOptions = {}): StdioHandle {
  const server = buildAiMcpServer(options)
  const stdioOptions: ServeStdioOptions = {}
  if (options.input) stdioOptions.input = options.input
  if (options.output) stdioOptions.output = options.output
  return serveStdio(server, stdioOptions)
}

export interface HttpStartOptions extends AiMcpOptions, ServeHttpOptions {}

/**
 * Build the server and serve it over the optional HTTP transport (opt-in;
 * stdio stays the default). Returns the {@link HttpHandle}.
 */
export function createAiMcpHttpServer(options: HttpStartOptions = {}): Promise<HttpHandle> {
  const server = buildAiMcpServer(options)
  const httpOptions: ServeHttpOptions = {}
  if (options.port !== undefined) httpOptions.port = options.port
  if (options.host !== undefined) httpOptions.host = options.host
  if (options.path !== undefined) httpOptions.path = options.path
  if (options.allowedHosts !== undefined) httpOptions.allowedHosts = options.allowedHosts
  if (options.allowedOrigins !== undefined) httpOptions.allowedOrigins = options.allowedOrigins
  if (options.allowRequest !== undefined) httpOptions.allowRequest = options.allowRequest
  return serveHttp(server, httpOptions)
}
