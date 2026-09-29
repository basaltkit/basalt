import type { Container } from '@basaltkit/core'
import { ensureMetadata } from '@basaltkit/core'
import {
  httpErrorReporter,
  isRouteVisible,
  redactSensitiveDetails,
  runRoute,
  toErrorResponse,
  zodToJsonSchema,
  type BasaltRoute,
  type ErrorDetailsRedactor,
  type HttpErrorReporter,
  type HttpReply,
  type HttpRequest,
  type RequestEnricher,
  type RouteGuard,
} from '@basaltkit/http'
import type { ZodType } from 'zod'
import type { McpToolResult } from './protocol.js'

/**
 * Per-call context. `headers` propagate tenancy/auth into the neutral pipeline
 * — filtered through the forwarded-header allowlist (see
 * {@link DEFAULT_FORWARDED_HEADERS}); `ip` becomes the tool request's
 * `request.ip` (rate limits, login throttles, audit); `signal` aborts the call
 * (read it in a handler with {@link toolSignal}).
 */
export interface ToolCallContext {
  headers?: Record<string, string | string[] | undefined>
  ip?: string
  signal?: AbortSignal
}

/**
 * Request headers a tool call inherits from its caller. Credentials and the
 * tenant travel (so a tool honours the same auth/tenancy as a direct request),
 * `cookie` included because session-cookie auth is a supported way to call
 * `/mcp` (the route's Origin/Content-Type checks keep it CSRF-safe). Everything
 * else is dropped — `x-request-id`/`x-correlation-id` (the tool mints its own),
 * conditional headers (`if-none-match` would turn a tool result into a 304),
 * `content-length`/`content-type` (describe the JSON-RPC envelope, not the
 * tool's input), hop-by-hop and forwarding headers (the client ip travels as
 * `ip`). Extend it with `mcpPlugin({ forwardHeaders })`.
 */
export const DEFAULT_FORWARDED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'x-api-key',
  'x-tenant-id',
  'host',
  'accept-language',
  'user-agent',
]

const signals = new WeakMap<HttpRequest, AbortSignal>()

/**
 * The abort signal of the MCP tool call a handler is running for, or
 * `undefined` for a plain HTTP request. It fires on `notifications/cancelled`
 * (from the same client session) — a long handler can check it and stop early.
 * The tool call itself answers "cancelled" as soon as it fires either way.
 */
export function toolSignal(request: HttpRequest): AbortSignal | undefined {
  return signals.get(request)
}

function filterHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
  allow: ReadonlySet<string>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  if (!headers) return out
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (value !== undefined && allow.has(key)) out[key] = value
  }
  return out
}

/** `/items/:id` + `{ id: 'a b' }` + `{ q: 'x' }` → `/items/a%20b?q=x` — the URL a direct request would have. */
function concreteUrl(pattern: string, params: Record<string, string>, query: unknown): string {
  const path = pattern.replace(/:([A-Za-z0-9_]+)/g, (whole, name: string) =>
    name in params ? encodeURIComponent(params[name]!) : whole,
  )
  if (!query || typeof query !== 'object') return path
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null || typeof item === 'object') continue
      search.append(key, String(item))
    }
  }
  const qs = search.toString()
  return qs ? `${path}?${qs}` : path
}

/** A route exposed to MCP. `invoke` runs it through the exact same request pipeline as HTTP. */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  invoke(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<McpToolResult>
  /**
   * Whether a caller with this request context (`ctx()` of the listing
   * request: `user`, `tenant`, …) should see the tool in `tools/list`. Pure —
   * see `isRouteVisible` in `@basaltkit/http` for exactly what it checks.
   * Never authorization: `invoke` runs the route's guards regardless.
   */
  visible(context: Record<string, unknown>): Promise<boolean>
}

/**
 * `meta.mcp` opt-in: `true`, or an object overriding the name/description and,
 * for this route's tool only, the error-details redactor (see
 * {@link ToolErrorOptions.redactErrorDetails}).
 */
type McpMetaObject = { name?: string; description?: string; redactErrorDetails?: ErrorDetailsRedactor | false }
type McpMeta = true | McpMetaObject

function mcpMeta(route: BasaltRoute): McpMeta | undefined {
  const value = route.meta?.['mcp']
  if (value === true) return true
  if (value && typeof value === 'object') return value as McpMetaObject
  return undefined
}

/**
 * How a tool call's failure is shaped for the model and reported to the
 * operator. The trust boundary: a thrown error reaches the MCP client — a
 * language model, and whoever can read or steer its context — as the same
 * `{ code, message, details? }` an HTTP client gets, so `details` passes
 * through {@link redactErrorDetails} on the way out, and `internalDetails`
 * never leaves: it goes to {@link reportError} only.
 */
export interface ToolErrorOptions {
  /**
   * Filters an error's public `details` before they enter a tool result.
   * Default: `redactSensitiveDetails` from `@basaltkit/http` — the value of
   * every key that names a secret (`password`, `token`, `apiKey`, `secret`,
   * `sessionId`, …) becomes `'[REDACTED]'`. Pass your own, or `false` to send
   * the details exactly as an HTTP client receives them. A route can override
   * it with `meta.mcp: { redactErrorDetails }`.
   */
  redactErrorDetails?: ErrorDetailsRedactor | false
  /**
   * Receives every error a tool call throws, with the error object untouched
   * (its log-only `internalDetails` included) — the same contract as the
   * adapters' `onError`. Default: `httpErrorReporter()` (5xx to
   * `console.error`, 4xx to `console.warn`). `false` reports nothing.
   */
  reportError?: HttpErrorReporter | false
}

/** `GET /projects/:id` → `get_projects_by_id` — a stable, agent-friendly tool name. */
export function defaultToolName(route: BasaltRoute): string {
  const path = route.url
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? `by_${seg.slice(1)}` : seg))
    .join('_')
  return `${route.method.toLowerCase()}${path ? `_${path}` : ''}`.replace(/[^a-z0-9_]/gi, '_')
}

// --- Zod introspection ---
// Reading `_def` is unlovely, but the alternative is parsing a sample value to
// learn a schema's shape. Zod 4 names the type in `_def.type` ('number') and
// exposes an object's fields as the plain record `_def.shape`.

type ZodDefLike = {
  type?: string
  innerType?: unknown
  shape?: Record<string, unknown>
}

const zodDef = (schema: unknown): ZodDefLike | undefined =>
  (schema as { _def?: ZodDefLike } | undefined)?._def

/** Lowercase type name, e.g. 'number' | 'object' | 'optional'. */
function zodType(schema: unknown): string | undefined {
  const def = zodDef(schema)
  return typeof def?.type === 'string' ? def.type : undefined
}

/** The shape record of a Zod object, or null. */
function zodShape(schema: unknown): Record<string, unknown> | null {
  if (zodType(schema) !== 'object') return null
  const shape = zodDef(schema)?.shape
  return shape && typeof shape === 'object' ? shape : null
}

/** Unwrap optional/default/nullable to the inner scalar type name. */
function unwrapType(schema: unknown): string | undefined {
  let current = schema
  let t = zodType(current)
  while (t === 'optional' || t === 'default' || t === 'nullable') {
    current = zodDef(current)?.innerType
    t = zodType(current)
  }
  return t
}

/** The property names of a Zod object schema, or null if it isn't a plain object. */
function objectKeys(schema: ZodType | undefined): string[] | null {
  const shape = zodShape(schema)
  return shape ? Object.keys(shape) : null
}

/** Coerce a stringified scalar to the type its Zod field expects (LLMs often send numbers/booleans as text). */
function coerceScalar(fieldSchema: unknown, value: unknown): unknown {
  if (typeof value !== 'string') return value
  const t = unwrapType(fieldSchema)
  if (t === 'number') {
    const n = Number(value)
    return value.trim() !== '' && !Number.isNaN(n) ? n : value
  }
  if (t === 'boolean') {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return value
}

/** Coerce an args object's string fields to the scalar types the Zod object declares. */
function coerceToSchema(
  schema: ZodType | undefined,
  obj: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!obj || !schema) return obj
  const shape = zodShape(schema)
  if (!shape) return obj
  const out: Record<string, unknown> = { ...obj }
  for (const key of Object.keys(out)) if (key in shape) out[key] = coerceScalar(shape[key], out[key])
  return out
}

/** Merge params + query + body into one flat JSON-Schema object — the tool's input. */
function buildInputSchema(route: BasaltRoute): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const schema of [route.params, route.query, route.body]) {
    if (!schema) continue
    const json = zodToJsonSchema(schema) as {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
    }
    if (json.type === 'object' && json.properties) {
      Object.assign(properties, json.properties)
      for (const key of json.required ?? []) if (!required.includes(key)) required.push(key)
    }
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

const pick = (source: Record<string, unknown>, keys: string[] | null): Record<string, unknown> | undefined => {
  if (!keys) return undefined
  const out: Record<string, unknown> = {}
  for (const key of keys) if (key in source) out[key] = source[key]
  return out
}

/** Split flat tool args back into the route's body/query/params by each schema's keys. */
function splitArgs(route: BasaltRoute, args: Record<string, unknown>) {
  const paramKeys = objectKeys(route.params)
  const params: Record<string, string> = {}
  if (paramKeys) for (const key of paramKeys) if (key in args) params[key] = String(args[key])
  const query = coerceToSchema(route.query, pick(args, objectKeys(route.query)) ?? (route.query ? args : undefined))
  const body = coerceToSchema(route.body, pick(args, objectKeys(route.body)) ?? (route.body ? args : undefined))
  return { params, query, body }
}

/** Captures a handler's reply so the tool call can read status + payload. */
class CapturingReply implements HttpReply {
  statusCode = 200
  sent = false
  payload: unknown = undefined
  raw: unknown = null
  private readonly outHeaders: Record<string, string> = {}
  code(status: number): this {
    this.statusCode = status
    return this
  }
  header(name: string, value: string): this {
    this.outHeaders[name.toLowerCase()] = value
    return this
  }
  send(payload?: unknown): unknown {
    this.sent = true
    this.payload = payload
    return payload
  }
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

const ABORTED = Symbol('aborted')

const cancelled = (): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ code: 'CANCELLED', message: 'Tool call cancelled' }) }],
  isError: true,
})

/** Build the invoker that runs a route through the shared neutral pipeline. */
function makeInvoke(
  route: BasaltRoute,
  container: Container,
  allow: ReadonlySet<string>,
  redact: ErrorDetailsRedactor | undefined,
  report: HttpErrorReporter | undefined,
) {
  const metadata = ensureMetadata(container)
  return async (args: Record<string, unknown>, callCtx?: ToolCallContext): Promise<McpToolResult> => {
    const signal = callCtx?.signal
    if (signal?.aborted) return cancelled()
    const { params, query, body } = splitArgs(route, args ?? {})
    const request: HttpRequest = {
      method: route.method,
      url: concreteUrl(route.url, params, query),
      routePattern: route.url,
      headers: filterHeaders(callCtx?.headers, allow),
      params,
      query,
      body,
      ...(callCtx?.ip !== undefined ? { ip: callCtx.ip } : {}),
      raw: null,
    }
    if (signal) signals.set(request, signal)
    const reply = new CapturingReply()
    try {
      const run = runRoute(route, request, reply, {
        container,
        enrichers: metadata.get<RequestEnricher>('http:enrichers'),
        guards: metadata.get<RouteGuard>('http:guards'),
      })
      // The pipeline cannot be interrupted from outside, but the CALL can: on
      // abort, answer "cancelled" now; the handler sees `toolSignal(request)`.
      let onAbort: (() => void) | undefined
      const aborted = signal
        ? new Promise<typeof ABORTED>((resolve) => {
            onAbort = () => resolve(ABORTED)
            signal.addEventListener('abort', onAbort, { once: true })
          })
        : undefined
      let returned: unknown
      try {
        returned = aborted ? await Promise.race([run, aborted]) : await run
      } finally {
        if (onAbort) signal!.removeEventListener('abort', onAbort)
      }
      if (returned === ABORTED) {
        run.catch(() => {}) // the abandoned handler may still reject later
        return cancelled()
      }
      const value = reply.sent ? reply.payload : returned
      const failed = reply.statusCode >= 400
      // MCP requires `structuredContent` to be a JSON object (a record) — never
      // an array or primitive. Arrays/primitives ride in the text content only,
      // which still carries the full JSON. Otherwise clients reject the result
      // with "expected record, received array".
      const isRecord = value !== null && typeof value === 'object' && !Array.isArray(value)
      return {
        content: [{ type: 'text', text: asText(value) }],
        ...(isRecord ? { structuredContent: value } : {}),
        // A handler that replied an error status (`reply.code(403)`) failed.
        ...(failed ? { isError: true } : {}),
      }
    } catch (error) {
      const { status, body: errorBody } = toErrorResponse(error, redact ? { redactDetails: redact } : {})
      if (report) {
        try {
          report({ error, status, code: errorBody.error.code, method: route.method, url: request.url })
        } catch {
          // A failing reporter must not turn a tool error into a transport one.
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(errorBody.error) }], isError: true }
    }
  }
}

/**
 * Collect the MCP tools from the routes opted in with `meta.mcp`. `container`
 * supplies the DI scope, enrichers and guards, so a tool call behaves exactly
 * like the equivalent HTTP request.
 */
export function collectTools(
  routes: BasaltRoute[],
  container: Container,
  options: { filter?: (route: BasaltRoute) => boolean; forwardHeaders?: string[] } & ToolErrorOptions = {},
): McpTool[] {
  const allow = new Set([...DEFAULT_FORWARDED_HEADERS, ...(options.forwardHeaders ?? [])].map((h) => h.toLowerCase()))
  const report = options.reportError === false ? undefined : (options.reportError ?? httpErrorReporter())
  const tools: McpTool[] = []
  for (const route of routes) {
    const meta = mcpMeta(route)
    if (!meta) continue
    if (options.filter && !options.filter(route)) continue
    const override: McpMetaObject = meta === true ? {} : meta
    const redact = override.redactErrorDetails ?? options.redactErrorDetails ?? redactSensitiveDetails
    tools.push({
      name: override.name ?? defaultToolName(route),
      description: override.description ?? `${route.method} ${route.url}`,
      inputSchema: buildInputSchema(route),
      invoke: makeInvoke(route, container, allow, redact === false ? undefined : redact, report),
      visible: (context) => isRouteVisible(route, context, container),
    })
  }
  return tools
}
