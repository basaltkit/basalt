import { definePlugin, ensureMetadata } from '@machize/core'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeAny } from 'zod'
import { FASTIFY } from './adapter.js'

 
type JsonSchema = Record<string, any>

/**
 * Minimal Zod → JSON Schema (OpenAPI 3.0 dialect) covering the subset used in
 * route definitions. Unknown types degrade to `{}` (any) rather than throwing,
 * so documentation generation never breaks a boot.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def: any = (schema as any)?._def
  if (!def) return {}
  switch (def.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' }
      for (const check of def.checks ?? []) {
        if (check.kind === 'email') out.format = 'email'
        else if (check.kind === 'url') out.format = 'uri'
        else if (check.kind === 'uuid') out.format = 'uuid'
        else if (check.kind === 'min') out.minLength = check.value
        else if (check.kind === 'max') out.maxLength = check.value
        else if (check.kind === 'regex') out.pattern = String(check.regex.source)
      }
      return out
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' }
      for (const check of def.checks ?? []) {
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
      return { const: def.value }
    case 'ZodEnum':
      return { type: 'string', enum: def.values }
    case 'ZodNativeEnum':
      return { enum: Object.values(def.values) }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type) }
    case 'ZodObject': {
      const shape = def.shape()
      const properties: JsonSchema = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        const child = value as ZodTypeAny
        properties[key] = zodToJsonSchema(child)
        if (!isOptional(child)) required.push(key)
      }
      const out: JsonSchema = { type: 'object', properties }
      if (required.length) out.required = required
      return out
    }
    case 'ZodOptional':
    case 'ZodNullable':
      return { ...zodToJsonSchema(def.innerType), ...(def.typeName === 'ZodNullable' ? { nullable: true } : {}) }
    case 'ZodDefault':
      return { ...zodToJsonSchema(def.innerType), default: def.defaultValue() }
    case 'ZodEffects':
      return zodToJsonSchema(def.schema)
    case 'ZodUnion':
      return { anyOf: def.options.map((option: ZodTypeAny) => zodToJsonSchema(option)) }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) }
    default:
      return {}
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const name = (schema as any)?._def?.typeName
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

/** `/users/:id` → `/users/{id}` (OpenAPI path templating). */
const toOpenApiPath = (url: string): string => url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')

/** Builds an OpenAPI 3.0 document from Machize route definitions. */
export function generateOpenApi(routes: RouteLike[], info: OpenApiInfo): JsonSchema {
  const paths: JsonSchema = {}
  let usesAuth = false

  for (const route of routes) {
    const path = toOpenApiPath(route.url)
    const method = route.method.toLowerCase()
    const operation: JsonSchema = { responses: {} }

    const parameters: JsonSchema[] = []
    if (route.params) {
      const schema = zodToJsonSchema(route.params)
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        parameters.push({ name, in: 'path', required: true, schema: prop })
      }
    }
    if (route.query) {
      const schema = zodToJsonSchema(route.query)
      const required = new Set<string>(schema.required ?? [])
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        parameters.push({ name, in: 'query', required: required.has(name), schema: prop })
      }
    }
    if (parameters.length) operation.parameters = parameters

    if (route.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: zodToJsonSchema(route.body) } },
      }
    }

    const responses = route.response ?? {}
    const statuses = Object.keys(responses)
    if (statuses.length === 0) {
      operation.responses['200'] = { description: 'OK' }
    } else {
      for (const status of statuses) {
        operation.responses[status] = {
          description: 'OK',
          content: { 'application/json': { schema: zodToJsonSchema(responses[Number(status)]!) } },
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
  /** Document path. Default '/openapi.json'. */
  path?: string
  /** Provide routes explicitly; otherwise read from the http:routes metadata. */
  routes?: RouteLike[]
}

/**
 * Serves an OpenAPI 3.0 document generated from the app's registered routes and
 * their Zod schemas — no duplicate annotations. Point Swagger UI / Redoc at it.
 */
export function openapiPlugin(options: OpenApiPluginOptions) {
  return definePlugin({
    name: 'machize:openapi',
    dependsOn: ['machize:fastify'],
    boot({ container }) {
      const app: FastifyInstance = container.get(FASTIFY)
      const routes = options.routes ?? ensureMetadata(container).get<RouteLike>('http:routes')
      const document = generateOpenApi(routes, options.info)
      app.route({
        method: 'GET',
        url: options.path ?? '/openapi.json',
        handler: async () => document,
      })
    },
  })
}
