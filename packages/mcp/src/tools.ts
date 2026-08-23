import type { Container } from '@basaltkit/core'
import { ensureMetadata } from '@basaltkit/core'
import {
  runRoute,
  toErrorResponse,
  zodToJsonSchema,
  type BasaltRoute,
  type HttpReply,
  type HttpRequest,
  type RequestEnricher,
  type RouteGuard,
} from '@basaltkit/http'
import type { ZodType } from 'zod'
import type { McpToolResult } from './protocol.js'

/** Per-call context: headers propagate tenancy/auth into the neutral pipeline. */
export interface ToolCallContext {
  headers?: Record<string, string | string[] | undefined>
}

/** A route exposed to MCP. `invoke` runs it through the exact same request pipeline as HTTP. */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  invoke(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<McpToolResult>
}

/** `meta.mcp` opt-in: `true`, or an object overriding the name/description. */
type McpMeta = true | { name?: string; description?: string }

function mcpMeta(route: BasaltRoute): McpMeta | undefined {
  const value = route.meta?.['mcp']
  if (value === true) return true
  if (value && typeof value === 'object') return value as { name?: string; description?: string }
  return undefined
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

// --- Zod introspection that works on both Zod 3 and Zod 4 ---
// v3 identifies types via `_def.typeName` ('ZodNumber') and exposes an object's
// shape as `_def.shape()` (a function). v4 uses `_def.type` ('number') and
// `_def.shape` (a plain object). These helpers normalise both.

type ZodDefLike = {
  typeName?: string
  type?: string
  innerType?: unknown
  shape?: Record<string, unknown> | (() => Record<string, unknown>)
}

const zodDef = (schema: unknown): ZodDefLike | undefined =>
  (schema as { _def?: ZodDefLike } | undefined)?._def

/** Normalised lowercase type name, e.g. 'number' | 'object' | 'optional'. */
function zodType(schema: unknown): string | undefined {
  const def = zodDef(schema)
  if (!def) return undefined
  if (typeof def.type === 'string') return def.type // v4
  if (typeof def.typeName === 'string' && def.typeName.startsWith('Zod')) {
    return def.typeName.slice(3).toLowerCase() // v3: 'ZodNumber' -> 'number'
  }
  return undefined
}

/** The shape record of a Zod object (both versions), or null. */
function zodShape(schema: unknown): Record<string, unknown> | null {
  if (zodType(schema) !== 'object') return null
  const shape = zodDef(schema)?.shape
  const resolved = typeof shape === 'function' ? shape() : shape
  return resolved && typeof resolved === 'object' ? resolved : null
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

/** Build the invoker that runs a route through the shared neutral pipeline. */
function makeInvoke(route: BasaltRoute, container: Container) {
  const metadata = ensureMetadata(container)
  return async (args: Record<string, unknown>, callCtx?: ToolCallContext): Promise<McpToolResult> => {
    const { params, query, body } = splitArgs(route, args ?? {})
    const request: HttpRequest = {
      method: route.method,
      url: route.url,
      headers: callCtx?.headers ?? {},
      params,
      query,
      body,
      raw: null,
    }
    const reply = new CapturingReply()
    try {
      const returned = await runRoute(route, request, reply, {
        container,
        enrichers: metadata.get<RequestEnricher>('http:enrichers'),
        guards: metadata.get<RouteGuard>('http:guards'),
      })
      const value = reply.sent ? reply.payload : returned
      // MCP requires `structuredContent` to be a JSON object (a record) — never
      // an array or primitive. Arrays/primitives ride in the text content only,
      // which still carries the full JSON. Otherwise clients reject the result
      // with "expected record, received array".
      const isRecord = value !== null && typeof value === 'object' && !Array.isArray(value)
      return {
        content: [{ type: 'text', text: asText(value) }],
        ...(isRecord ? { structuredContent: value } : {}),
      }
    } catch (error) {
      const { body: errorBody } = toErrorResponse(error)
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
  options: { filter?: (route: BasaltRoute) => boolean } = {},
): McpTool[] {
  const tools: McpTool[] = []
  for (const route of routes) {
    const meta = mcpMeta(route)
    if (!meta) continue
    if (options.filter && !options.filter(route)) continue
    const override = meta === true ? {} : meta
    tools.push({
      name: override.name ?? defaultToolName(route),
      description: override.description ?? `${route.method} ${route.url}`,
      inputSchema: buildInputSchema(route),
      invoke: makeInvoke(route, container),
    })
  }
  return tools
}
