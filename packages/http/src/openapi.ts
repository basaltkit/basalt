import { definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import { z, type ZodTypeAny } from 'zod'
import { idempotencyStageOf } from './idempotency.js'
import { HTTP_SERVER } from './server.js'
import { isRawBody } from './raw-body.js'
import { isUploadBody } from './upload.js'

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

/** How API keys are advertised (see {@link GenerateOpenApiOptions.apiKey}). */
export interface OpenApiApiKeyOptions {
  /** The request header carrying the key (apiKeysPlugin's `header`, default `x-api-key`). */
  header: string
  /**
   * Also offer the API key as an alternative to the session on `meta.auth`
   * routes (that do not set `meta.apiKey: false`). Off by default, because
   * it is only true when a key really passes those routes: the keys carry a
   * `userId`, apiKeysPlugin was given `users` (so a key resolves `ctx().user`),
   * and the keys hold `*` or apiKeysPlugin sets `allowNarrowKeysOnUnscopedRoutes`.
   * Otherwise those routes answer 401/403 to a key, and the document would say
   * they accept one.
   */
  onAuthRoutes?: boolean
}

/** Options of {@link generateOpenApi} beyond the routes, info and tags. */
export interface GenerateOpenApiOptions {
  /**
   * The API-key security scheme (`apiKeyAuth`). Omitted: the `x-api-key`
   * header, used on `meta.scopes` routes only. `false`: never advertised
   * (`x-required-scopes` is still emitted — it is a fact about the route).
   */
  apiKey?: OpenApiApiKeyOptions | false
  /** Document the idempotency header on these methods (what idempotencyPlugin enforces). */
  idempotency?: { header: string; methods: readonly string[] } | false
}

const DEFAULT_API_KEY_HEADER = 'x-api-key'

const IDEMPOTENCY_DESCRIPTION =
  'Makes a retry safe. A request repeated with the same key replays the stored response ' +
  '(marked with the `idempotent-replayed: true` header) instead of running again. ' +
  '409 while the first request with this key is still in progress; ' +
  '422 when the key was already used with a different request.'

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
 *
 * Security, per operation, from `route.meta`:
 * - `meta.scopes` (non-empty): `apiKeyAuth` — only an API key holding the
 *   scopes passes — plus `x-required-scopes` listing them (OpenAPI 3.0.3
 *   allows scopes in a requirement only for OAuth2/OpenID schemes).
 * - else `meta.auth: true`: `bearerAuth`, and `apiKeyAuth` as an alternative
 *   only with `options.apiKey.onAuthRoutes` (and not `meta.apiKey: false`).
 * - else: public.
 * Only the schemes an operation uses are listed in `components`.
 */
export function generateOpenApi(
  routes: RouteLike[],
  info: OpenApiInfo,
  tags: OpenApiTag[] = [],
  options: GenerateOpenApiOptions = {},
): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {}
  const usedTags = new Set<string>()
  let usesAuth = false
  let usesApiKey = false
  const usedScopes = new Set<string>()
  const apiKey = options.apiKey === false ? undefined : (options.apiKey ?? { header: DEFAULT_API_KEY_HEADER })
  const idempotency = options.idempotency || undefined
  const idempotentMethods = new Set((idempotency?.methods ?? []).map((m) => m.toUpperCase()))

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
    if (idempotency && idempotentMethods.has(route.method.toUpperCase())) {
      parameters.push({
        name: idempotency.header,
        in: 'header',
        required: false,
        schema: { type: 'string', maxLength: 255 },
        description: IDEMPOTENCY_DESCRIPTION,
      })
    }
    if (parameters.length) operation.parameters = parameters

    if (route.body && isUploadBody(route.body)) {
      // A streamed `upload()` body: files and text fields, names chosen by the client.
      operation.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', additionalProperties: { type: 'string', format: 'binary' } },
          },
        },
      }
    } else if (route.body && isRawBody(route.body)) {
      // A `rawBody()` body: whatever the client sent, verbatim. There is no
      // schema to publish — the bytes are the message.
      operation.requestBody = {
        required: true,
        content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
      }
    } else if (route.body) {
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

    const scopes = Array.isArray(meta['scopes']) ? meta['scopes'].filter((s): s is string => typeof s === 'string') : []
    if (scopes.length > 0) {
      // apiKeysPlugin satisfies meta.scopes from the API key only: a session
      // alone is refused, even when meta.auth is set too.
      if (apiKey) {
        operation.security = [{ apiKeyAuth: [] }]
        usesApiKey = true
      }
      operation['x-required-scopes'] = [...scopes]
      for (const scope of scopes) usedScopes.add(scope)
    } else if (meta['auth'] === true) {
      const alternatives: JsonSchema[] = [{ bearerAuth: [] }]
      if (apiKey?.onAuthRoutes === true && meta['apiKey'] !== false) {
        alternatives.push({ apiKeyAuth: [] })
        usesApiKey = true
      }
      operation.security = alternatives
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
  if (usesAuth || usesApiKey) {
    const securitySchemes: JsonSchema = {}
    if (usesAuth) securitySchemes['bearerAuth'] = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
    if (usesApiKey && apiKey) {
      securitySchemes['apiKeyAuth'] = {
        type: 'apiKey',
        in: 'header',
        name: apiKey.header,
        description: apiKeyDescription(apiKey.header, [...usedScopes].sort()),
      }
    }
    document.components = { securitySchemes }
  }
  return document
}

function apiKeyDescription(header: string, scopes: readonly string[]): string {
  let text =
    `API key in the \`${header}\` header (also accepted as \`Authorization: Bearer <key>\`). ` +
    'A key without the `*` scope reaches only the operations that list `x-required-scopes`, and must hold every scope listed there.'
  if (scopes.length > 0) text += ` Scopes used by this API: ${scopes.map((s) => `\`${s}\``).join(', ')}.`
  return text
}

export interface OpenApiPluginOptions {
  info: OpenApiInfo
  path?: string
  routes?: RouteLike[]
  /** Top-level tag list (names + descriptions) for grouping in the docs UI. */
  tags?: OpenApiTag[]
  /**
   * The API-key scheme. Omitted: the `x-api-key` header, on `meta.scopes`
   * routes. Pass `{ header }` when apiKeysPlugin uses a custom header, and
   * `onAuthRoutes: true` only when keys really pass `meta.auth` routes (see
   * {@link OpenApiApiKeyOptions.onAuthRoutes}). `false` hides it.
   */
  apiKey?: OpenApiApiKeyOptions | false
  /**
   * The idempotency header is documented automatically on the methods
   * idempotencyPlugin guards; `false` leaves it out.
   */
  idempotency?: false
}

/** The generation options the plugin derives from its options and the container. */
function generationOptions(container: Container, options: OpenApiPluginOptions): GenerateOpenApiOptions {
  const stage = options.idempotency === false ? undefined : idempotencyStageOf(container)
  return {
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(stage ? { idempotency: stage.describe() } : {}),
  }
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
        document = generateOpenApi(routes, options.info, options.tags, generationOptions(container, options))
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
      const document = generateOpenApi(routes, options.info, options.tags, generationOptions(container, options))
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
