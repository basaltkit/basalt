import { timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import type { IncomingMessage } from 'node:http'
import {
  McpServer,
  serveHttp,
  serveStdio,
  type HttpHandle,
  type McpServerOptions,
  type ServeHttpOptions,
  type ServeStdioOptions,
  type StdioHandle,
} from '@basaltkit/mcp-core'
import { assertDevOnly } from './guard.js'
import { createSession, type SessionOptions } from './session.js'
import { analyzeTool } from './tools/analyze.js'
import { doctorTool } from './tools/doctor.js'
import { planTool } from './tools/plan.js'
import { reviewTool } from './tools/review.js'
import { makeTool } from './tools/make.js'
import { projectResources } from './resources/project.js'
import { knowledgeResources } from './resources/knowledge.js'
import { workflowPrompts } from './prompts/workflows.js'

/** The published package version, read from its own `package.json` so it can't drift. */
export const AI_MCP_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version
const SERVER_INFO = { name: 'basalt-ai-mcp', version: AI_MCP_VERSION }

export interface AiMcpOptions extends SessionOptions {
  /**
   * Receives the original error when a tool/resource/prompt fails unexpectedly.
   * The MCP client only sees a generic `Internal error`; the `basalt-ai-mcp`
   * bin logs the real cause to stderr through this hook.
   */
  onError?: McpServerOptions['onError']
}

/**
 * Build the read-only AI MCP server: the `basalt_analyze` / `basalt_doctor`
 * tools plus the `basalt://project/*` and `basalt://knowledge/*` resources,
 * wired into a generic `@basaltkit/mcp-core` server. Programmatic entry for
 * tests and the bin — never imported by an application's runtime. Throws
 * `AiMcpProductionError` when `NODE_ENV` is `production` (unless
 * `allowProduction`), so every entry point (stdio, HTTP, embedded) is guarded.
 */
export function buildAiMcpServer(options: AiMcpOptions = {}): McpServer {
  // Dev-only at runtime too: refuse a production process (see guard.ts).
  assertDevOnly(options.env ?? process.env, options.allowProduction === true)
  const session = createSession(options)
  return new McpServer({
    tools: [analyzeTool(session), doctorTool(session), planTool(session), reviewTool(session), makeTool(session)],
    resources: [...projectResources(session), ...knowledgeResources()],
    prompts: workflowPrompts(),
    serverInfo: SERVER_INFO,
    ...(options.onError ? { onError: options.onError } : {}),
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

export interface HttpStartOptions extends AiMcpOptions, ServeHttpOptions {
  /**
   * Shared secret: every request must carry `Authorization: Bearer <token>`.
   * Required to bind a non-loopback `host` (unless `authorize`/`allowRequest`
   * is given) — the Host/Origin guard is not authentication.
   */
  token?: string
}

/** `authorize` hook comparing `Authorization: Bearer <token>` in constant time. */
export function bearerAuthorizer(token: string): (req: IncomingMessage) => boolean {
  const expected = Buffer.from(`Bearer ${token}`)
  return (req) => {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const got = Buffer.from(header)
    return got.length === expected.length && timingSafeEqual(got, expected)
  }
}

/**
 * Build the server and serve it over the optional HTTP transport (opt-in;
 * stdio stays the default). Returns the {@link HttpHandle}.
 *
 * `sessions: true` (or `{ ttlMs, maxSessions }`) turns on mcp-core's
 * Streamable-HTTP sessions: `initialize` issues an `Mcp-Session-Id`, later
 * requests must carry it, and a `notifications/cancelled` POSTed separately
 * cancels the call it names (e.g. a long `basalt_make`). Default off. With a
 * `token`, a session is bound to it (the default `principal` hashes the
 * `Authorization` header).
 */
export async function createAiMcpHttpServer(options: HttpStartOptions = {}): Promise<HttpHandle> {
  const server = buildAiMcpServer(options)
  const httpOptions: ServeHttpOptions = {}
  if (options.port !== undefined) httpOptions.port = options.port
  if (options.host !== undefined) httpOptions.host = options.host
  if (options.path !== undefined) httpOptions.path = options.path
  if (options.allowedHosts !== undefined) httpOptions.allowedHosts = options.allowedHosts
  if (options.allowedOrigins !== undefined) httpOptions.allowedOrigins = options.allowedOrigins
  if (options.allowRequest !== undefined) httpOptions.allowRequest = options.allowRequest
  if (options.maxBodyBytes !== undefined) httpOptions.maxBodyBytes = options.maxBodyBytes
  // Opt-in `Mcp-Session-Id` sessions (cross-POST cancellation); stateless by
  // default, like mcp-core, so header-less clients keep working.
  if (options.sessions !== undefined) httpOptions.sessions = options.sessions
  if (options.principal !== undefined) httpOptions.principal = options.principal
  if (options.authorize !== undefined) httpOptions.authorize = options.authorize
  else if (options.token) httpOptions.authorize = bearerAuthorizer(options.token)
  return serveHttp(server, httpOptions)
}
