import { randomUUID } from 'node:crypto'
import { Container, BasaltError, runWithContext, type RequestContext } from '@basaltkit/core'
import type { ZodType } from 'zod'
import { RequestValidationError, type ValidationIssue, GuardsWithoutContainerError } from './errors.js'
import { computeEtag, ifNoneMatchSatisfied } from './etag.js'
import type { HttpReply, HttpRequest, BasaltRoute } from './route.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** Per-request DI scope — `scoped` instances live here. */
    container?: Container
  }
}

/**
 * Runs inside the request context, before validation and the handler. Plugins
 * register enrichers in the 'http:enrichers' metadata bucket — tenancy uses
 * this to resolve and attach the current tenant.
 */
export type RequestEnricher = (info: {
  request: HttpRequest
  context: RequestContext
  container: Container
  /**
   * The route being served, so an enricher can honour its `meta` — tenancy
   * uses `meta.tenant` to tell central routes from tenant ones. Optional
   * because enrichers written before this existed do not read it.
   */
  route?: BasaltRoute
}) => void | Promise<void>

/**
 * Runs after enrichers, with access to the route definition (and its `meta`).
 * Plugins register guards in the 'http:guards' metadata bucket — auth uses
 * `meta.auth`, permissions uses `meta.can`. A guard rejects by throwing.
 */
export type RouteGuard = (info: {
  route: BasaltRoute
  request: HttpRequest
  context: RequestContext
  container: Container
}) => void | Promise<void>

export interface RoutePipeline {
  container?: Container
  enrichers?: RequestEnricher[]
  guards?: RouteGuard[]
}

const headerValue = (request: HttpRequest, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function parsePart(part: 'body' | 'query' | 'params', schema: ZodType | undefined, input: unknown): unknown {
  if (!schema) return undefined
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
  throw new RequestValidationError(part, issues)
}

/**
 * Sets a strong ETag for `meta.etag` GET/HEAD responses and short-circuits to
 * 304 when the client's If-None-Match matches. No-op if the handler already
 * replied or returned nothing.
 */
function applyEtag(
  definition: BasaltRoute,
  request: HttpRequest,
  reply: HttpReply,
  result: unknown,
): unknown {
  if (definition.meta?.['etag'] !== true) return result
  const method = request.method.toUpperCase()
  if ((method !== 'GET' && method !== 'HEAD') || reply.sent || result === undefined || result === null) {
    return result
  }
  const body = typeof result === 'string' ? result : JSON.stringify(result)
  const etag = computeEtag(body)
  reply.header('etag', etag)
  if (ifNoneMatchSatisfied(headerValue(request, 'if-none-match'), etag)) {
    reply.code(304).send()
    return undefined
  }
  return result
}

/**
 * The framework-neutral request pipeline every adapter shares: establishes the
 * request context (id, correlation, scoped container), runs enrichers then
 * guards, validates body/query/params, and invokes the handler. Returns the
 * handler's value (the adapter sends it unless the handler already replied).
 */
export async function runRoute(
  definition: BasaltRoute,
  request: HttpRequest,
  reply: HttpReply,
  pipeline: RoutePipeline = {},
): Promise<unknown> {
  const requestId = headerValue(request, 'x-request-id') ?? randomUUID()
  const context: RequestContext = {
    requestId,
    correlationId: headerValue(request, 'x-correlation-id') ?? requestId,
    ...(pipeline.container ? { container: pipeline.container.createScope() } : {}),
  }
  reply.header('x-request-id', requestId)

  return runWithContext(context, async () => {
    const scoped = context.container
    // Fail closed: guards that cannot run must never be silently skipped.
    if (!scoped && (pipeline.guards?.length ?? 0) > 0) {
      throw new GuardsWithoutContainerError(
        `${definition.method} ${definition.url}`,
        pipeline.guards?.length ?? 0,
      )
    }
    if (scoped) {
      for (const enrich of pipeline.enrichers ?? [])
        await enrich({ route: definition, request, context, container: scoped })
      for (const guard of pipeline.guards ?? []) await guard({ route: definition, request, context, container: scoped })
    }
    const result = await definition.handler({
      body: parsePart('body', definition.body, request.body),
      query: parsePart('query', definition.query, request.query),
      params: parsePart('params', definition.params, request.params),
      request,
      reply,
    } as Parameters<BasaltRoute['handler']>[0])
    return applyEtag(definition, request, reply, result)
  })
}

export interface ErrorResponse {
  status: number
  body: { error: { code: string; message: string; part?: string; issues?: ValidationIssue[] } }
}

/**
 * Maps a thrown error to a standardized HTTP response — shared by all adapters
 * so error shapes are identical regardless of framework.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof RequestValidationError) {
    return {
      status: 400,
      body: { error: { code: error.code, message: error.message, part: error.part, issues: error.issues } },
    }
  }
  if (error instanceof BasaltError) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') {
      return { status, body: { error: { code: error.code, message: error.message } } }
    }
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } } }
}
