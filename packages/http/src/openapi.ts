import { definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import { z, type ZodTypeAny } from 'zod'
import { HTTP_SERVER } from './server.js'

type JsonSchema = Record<string, unknown>

/**
 * Zod → JSON Schema (OpenAPI 3.0 dialect), delegating to Zod's own converter.
 *
 * Until zod 4 became the requirement this function also carried a hand-rolled
 * `switch` over `_def.typeName` for zod 3, which the native converter replaces
 * outright. Unknown types still degrade to `{}` rather than throwing: an
 * OpenAPI document missing a constraint is far better than a boot that fails.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  // A date is not a JSON type, so the native converter drops it to {}. The
  // OpenAPI shape is more useful to a client than nothing.
  if (schema instanceof z.ZodDate) return { type: 'string', format: 'date-time' }

  // Normalise the native output to the shape Basalt has always emitted,
  // recursively (nested objects and arrays too): drop the $schema banner, strip
  // the JS safe-integer bounds it stamps on every number, and treat a property
  // with a `default` as optional — a client may omit it.
  const clean = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(clean)
    const o = node as Record<string, unknown>
    delete o['$schema']
    if (o['minimum'] === -9007199254740991 || o['minimum'] === Number.MIN_SAFE_INTEGER) delete o['minimum']
    if (o['maximum'] === 9007199254740991 || o['maximum'] === Number.MAX_SAFE_INTEGER) delete o['maximum']
    const props = o['properties'] as Record<string, JsonSchema> | undefined
    if (props && Array.isArray(o['required'])) {
      o['required'] = (o['required'] as string[]).filter((k) => props[k]?.['default'] === undefined)
      if ((o['required'] as string[]).length === 0) delete o['required']
    }
    for (const v of Object.values(o)) clean(v)
    return o
  }

  try {
    return clean(z.toJSONSchema(schema, { target: 'openapi-3.0', unrepresentable: 'any' })) as JsonSchema
  } catch {
    // A schema the OpenAPI 3.0 target refuses (a bigint, a custom type) may
    // still convert against the default target.
    try {
      return clean(z.toJSONSchema(schema)) as JsonSchema
    } catch {
      return {}
    }
  }
}

export interface OpenApiInfo {
  title: string
  version: string
  description?: string
}

/** A top-level OpenAPI tag: a group name and an optional human description. */
export interface OpenApiTag {
  name: string
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

/**
 * Builds an OpenAPI 3.0 document from Basalt route definitions.
 *
 * Per-operation tags come from `route.meta.tags`; pass `tags` to add a top-level
 * `tags` array (names + descriptions) that tools like Swagger UI use to order
 * and describe the groups. Any tag used on an operation but missing from `tags`
 * is still listed (name only), so groups are never dropped.
 */
export function generateOpenApi(routes: RouteLike[], info: OpenApiInfo, tags: OpenApiTag[] = []): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {}
  const usedTags = new Set<string>()
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
    if (Array.isArray(meta['tags'])) {
      const opTags = meta['tags'].filter((t): t is string => typeof t === 'string')
      operation.tags = opTags
      for (const t of opTags) usedTags.add(t)
    }
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

  // Top-level tags: the provided ones (in order, with descriptions) first, then
  // any tag used on an operation that wasn't described, so no group is lost.
  const documentTags: OpenApiTag[] = [
    ...tags, // described groups, in the caller's order
    ...[...usedTags].filter((name) => !tags.some((t) => t.name === name)).map((name) => ({ name })),
  ]

  const document: JsonSchema = {
    openapi: '3.0.3',
    info: { title: info.title, version: info.version, ...(info.description ? { description: info.description } : {}) },
    ...(documentTags.length > 0 ? { tags: documentTags } : {}),
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
  /** Top-level tag list (names + descriptions) for grouping in the docs UI. */
  tags?: OpenApiTag[]
}

/** Serves an OpenAPI 3.0 document from the registered routes (any adapter). */
export function openapiPlugin(options: OpenApiPluginOptions) {
  return definePlugin({
    name: 'basalt:openapi',
    register({ container }) {
      registerDocsCommand(container, options)
    },
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
        document = generateOpenApi(routes, options.info, options.tags)
      })
      container.get(HTTP_SERVER).addRoute('GET', options.path ?? '/openapi.json', () => document)
    },
  })
}

/**
 * Registers `generate:docs` into the CLI command bucket. It rebuilds the OpenAPI
 * document from the same routes/info/tags the plugin serves and writes it to a
 * file (`--out`, default `openapi.json`) or stdout (`--stdout`). Structural
 * registration keeps @basaltkit/http free of a hard @basaltkit/cli dependency.
 */
function registerDocsCommand(container: Container, options: OpenApiPluginOptions): void {
  ensureMetadata(container).add('commands', {
    name: 'generate:docs',
    description: 'Write the OpenAPI 3.0 document (--out=<file> | --stdout)',
    async handle({
      io,
      flags,
    }: {
      io: { log(m: string): void; error(m: string): void }
      flags: Record<string, string | boolean>
    }) {
      const routes = options.routes ?? ensureMetadata(container).get<RouteLike>('http:routes')
      const document = generateOpenApi(routes, options.info, options.tags)
      const json = JSON.stringify(document, null, 2)
      if (flags['stdout'] === true) {
        io.log(json)
        return
      }
      const out = typeof flags['out'] === 'string' ? flags['out'] : 'openapi.json'
      const { writeFile } = await import('node:fs/promises')
      await writeFile(out, `${json}\n`, 'utf8')
      io.log(`Wrote ${Object.keys(document.paths as object).length} path(s) to ${out}.`)
    },
  })
}
