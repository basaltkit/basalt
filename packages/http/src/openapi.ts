import { definePlugin, ensureMetadata } from '@basaltkit/core'
import type { ZodTypeAny } from 'zod'
import { HTTP_SERVER } from './server.js'

type JsonSchema = Record<string, unknown>

/**
 * Minimal Zod → JSON Schema (OpenAPI 3.0 dialect) covering the subset used in
 * route definitions. Unknown types degrade to `{}` rather than throwing.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = (schema as { _def?: Record<string, unknown> })?._def as Record<string, unknown> | undefined
  if (!def) return {}
  const anyDef = def as Record<string, unknown> & { typeName: string; checks?: { kind: string; value?: unknown; regex?: RegExp }[] }
  switch (anyDef.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' }
      for (const check of anyDef.checks ?? []) {
        if (check.kind === 'email') out.format = 'email'
        else if (check.kind === 'url') out.format = 'uri'
        else if (check.kind === 'uuid') out.format = 'uuid'
        else if (check.kind === 'min') out.minLength = check.value
        else if (check.kind === 'max') out.maxLength = check.value
        else if (check.kind === 'regex') out.pattern = String(check.regex?.source)
      }
      return out
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' }
      for (const check of anyDef.checks ?? []) {
        if (check.kind === 'int') out.type = 'integer'
        else if (check.kind === 'min') out.minimum = check.value
        else if (check.kind === 'max') out.maximum = check.value
      }
      return out
    }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodDate':
      return { type: 'string', format: 'date-time' }
    case 'ZodLiteral':
      return { const: (def as { value: unknown }).value }
    case 'ZodEnum':
      return { type: 'string', enum: (def as { values: unknown[] }).values }
    case 'ZodNativeEnum':
      return { enum: Object.values((def as { values: object }).values) }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema((def as { type: ZodTypeAny }).type) }
    case 'ZodObject': {
      const shape = (def as { shape: () => Record<string, ZodTypeAny> }).shape()
      const properties: JsonSchema = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value)
        if (!isOptional(value)) required.push(key)
      }
      const out: JsonSchema = { type: 'object', properties }
      if (required.length) out.required = required
      return out
    }
    case 'ZodOptional':
    case 'ZodNullable':
      return {
        ...zodToJsonSchema((def as { innerType: ZodTypeAny }).innerType),
        ...(anyDef.typeName === 'ZodNullable' ? { nullable: true } : {}),
      }
    case 'ZodDefault':
      return {
        ...zodToJsonSchema((def as { innerType: ZodTypeAny }).innerType),
        default: (def as { defaultValue: () => unknown }).defaultValue(),
      }
    case 'ZodEffects':
      return zodToJsonSchema((def as { schema: ZodTypeAny }).schema)
    case 'ZodUnion':
      return { anyOf: (def as { options: ZodTypeAny[] }).options.map((option) => zodToJsonSchema(option)) }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema((def as { valueType: ZodTypeAny }).valueType) }
    default:
      return {}
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const name = (schema as { _def?: { typeName?: string } })?._def?.typeName
  return name === 'ZodOptional' || name === 'ZodDefault'
}

export interface OpenApiInfo {
  title: string
  version: string
  description?: string
}

export interface RouteLike {
  method: string
  url: string
  meta?: Record<string, unknown>
  body?: ZodTypeAny
  query?: ZodTypeAny
  params?: ZodTypeAny
  response?: Record<number, ZodTypeAny>
}

const toOpenApiPath = (url: string): string => url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')

/** Human descriptions for the common status codes (fallback: "OK"). */
const STATUS_TEXT: Record<string, string> = {
  '200': 'OK',
  '201': 'Created',
  '204': 'No Content',
  '400': 'Validation error',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not Found',
  '409': 'Conflict',
  '500': 'Internal server error',
}

/** Builds an OpenAPI 3.0 document from Basalt route definitions. */
export function generateOpenApi(routes: RouteLike[], info: OpenApiInfo): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {}
  let usesAuth = false

  for (const route of routes) {
    const path = toOpenApiPath(route.url)
    const method = route.method.toLowerCase()
    const operation: JsonSchema = { responses: {} }
    const responses = operation.responses as Record<string, unknown>

    // OpenAPI enrichment from route.meta (summary/description/tags/operationId).
    const meta = route.meta ?? {}
    if (typeof meta['summary'] === 'string') operation.summary = meta['summary']
    if (typeof meta['description'] === 'string') operation.description = meta['description']
    if (Array.isArray(meta['tags'])) operation.tags = meta['tags'].filter((t): t is string => typeof t === 'string')
    if (typeof meta['operationId'] === 'string') operation.operationId = meta['operationId']

    const parameters: JsonSchema[] = []
    if (route.params) {
      const schema = zodToJsonSchema(route.params)
      for (const [name, prop] of Object.entries((schema.properties as JsonSchema) ?? {})) {
        parameters.push({ name, in: 'path', required: true, schema: prop })
      }
    }
    if (route.query) {
      const schema = zodToJsonSchema(route.query)
      const req = new Set<string>((schema.required as string[]) ?? [])
      for (const [name, prop] of Object.entries((schema.properties as JsonSchema) ?? {})) {
        parameters.push({ name, in: 'query', required: req.has(name), schema: prop })
      }
    }
    if (parameters.length) operation.parameters = parameters

    if (route.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: zodToJsonSchema(route.body) } },
      }
    }

    const statuses = Object.keys(route.response ?? {})
    if (statuses.length === 0) {
      responses['200'] = { description: STATUS_TEXT['200'] }
    } else {
      for (const status of statuses) {
        responses[status] = {
          description: STATUS_TEXT[status] ?? 'OK',
          content: { 'application/json': { schema: zodToJsonSchema(route.response![Number(status)]!) } },
        }
      }
    }

    if (route.meta?.['auth'] === true) {
      operation.security = [{ bearerAuth: [] }]
      usesAuth = true
    }

    paths[path] = { ...(paths[path] ?? {}), [method]: operation }
  }

  const document: JsonSchema = {
    openapi: '3.0.3',
    info: { title: info.title, version: info.version, ...(info.description ? { description: info.description } : {}) },
    paths,
  }
  if (usesAuth) {
    document.components = {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    }
  }
  return document
}

export interface OpenApiPluginOptions {
  info: OpenApiInfo
  path?: string
  routes?: RouteLike[]
}

/** Serves an OpenAPI 3.0 document from the registered routes (any adapter). */
export function openapiPlugin(options: OpenApiPluginOptions) {
  return definePlugin({
    name: 'basalt:openapi',
    boot({ container, hooks }) {
      const metadata = ensureMetadata(container)
      // Placeholder until routes are collected — see the app:booted handler.
      let document: JsonSchema = {
        openapi: '3.0.3',
        info: {
          title: options.info.title,
          version: options.info.version,
          ...(options.info.description ? { description: options.info.description } : {}),
        },
        paths: {},
      }
      // Adapters publish `http:routes` during their own boot phase, so building
      // the document here would depend on plugin order. Defer to app:booted —
      // by then every plugin has registered its routes, and the server has not
      // started listening yet, so no request can observe the placeholder.
      hooks.on('app:booted', () => {
        const routes = options.routes ?? metadata.get<RouteLike>('http:routes')
        document = generateOpenApi(routes, options.info)
      })
      container.get(HTTP_SERVER).addRoute('GET', options.path ?? '/openapi.json', () => document)
    },
  })
}
