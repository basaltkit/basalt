import { randomUUID } from 'node:crypto'
import { Container, BasaltError, runWithContext, type RequestContext } from '@basaltkit/core'
import type { ZodType } from 'zod'
import { sanitizeErrorDetails, type ErrorDetails } from './error-details.js'
import { RequestValidationError, type ValidationIssue, GuardsWithoutContainerError } from './errors.js'
import { computeEtag, ifNoneMatchSatisfied } from './etag.js'
import type { HttpReply, HttpRequest, BasaltRoute } from './route.js'
import { isSseResponse } from './sse.js'
import { isStreamResponse } from './stream.js'
import { UploadSession, uploadOptionsOf } from './upload.js'

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
  /**
   * The reply, so a guard can set response headers (e.g. `Retry-After`) before
   * rejecting. Optional: a pipeline may run guards without one.
   */
  reply?: HttpReply
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

/**
 * Shape an inbound `x-request-id` / `x-correlation-id` must have to be adopted.
 * The id lands in every log line, audit entry and response of the request, so
 * a client-chosen value is accepted only when it is short and cannot carry
 * separators, quotes, whitespace or control characters; otherwise a fresh id is
 * generated.
 */
const TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/

const inboundId = (request: HttpRequest, name: string): string | undefined => {
  const value = headerValue(request, name)
  return value !== undefined && TRACE_ID.test(value) ? value : undefined
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
  // A streamed body (`stream()`) or an event stream (`sse()`) is a marker the
  // adapter renders, not a payload: serialising it would hash the marker and
  // answer 304 for a body that was never sent.
  if (isStreamResponse(result) || isSseResponse(result)) return result
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
  const requestId = inboundId(request, 'x-request-id') ?? randomUUID()
  const context: RequestContext = {
    requestId,
    correlationId: inboundId(request, 'x-correlation-id') ?? requestId,
    ...(pipeline.container ? { container: pipeline.container.createScope() } : {}),
  }
  reply.header('x-request-id', requestId)

  // An `upload()` body is streamed, not parsed up front: nothing is read from
  // the transport until enrichers and guards have all passed, and whatever the
  // route leaves unread is released (drained, connection closed) at the end.
  const uploadOptions = uploadOptionsOf(definition.body)
  const session = uploadOptions ? new UploadSession(request, uploadOptions) : undefined

  return runWithContext(context, async () => {
    try {
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
        for (const guard of pipeline.guards ?? [])
          await guard({ route: definition, request, context, container: scoped, reply })
      }
      const parsedBody = session ? undefined : parsePart('body', definition.body, request.body)
      const query = parsePart('query', definition.query, request.query)
      const params = parsePart('params', definition.params, request.params)
      const result = await definition.handler({
        body: session ? session.open() : parsedBody,
        query,
        params,
        request,
        reply,
      } as Parameters<BasaltRoute['handler']>[0])
      return applyEtag(definition, request, reply, result)
    } finally {
      session?.release(reply)
    }
  })
}

export interface ErrorResponse {
  status: number
  body: {
    error: {
      code: string
      message: string
      part?: string
      issues?: ValidationIssue[]
      /**
       * Structured payload from an error deliberately constructed with one
       * (`new HttpError(status, code, message, { details })`, or any
       * `BasaltError` with a numeric `status`). Absent otherwise — an
       * unexpected exception never grows one.
       */
      details?: ErrorDetails
    }
  }
}

/**
 * Maps a thrown error to a standardized HTTP response — shared by all adapters
 * so error shapes are identical regardless of framework.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof RequestValidationError) {
    // Unchanged on purpose: `part` and `issues` are the documented validation
    // contract and predate `details`; folding them in would break every client.
    return {
      status: 400,
      body: { error: { code: error.code, message: error.message, part: error.part, issues: error.issues } },
    }
  }
  if (error instanceof BasaltError) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') {
      // Sanitised, not passed through: `details` reaches the client verbatim,
      // so it must be plain, acyclic, bounded JSON data or nothing at all.
      const details = sanitizeErrorDetails(error.details)
      return {
        status,
        body: { error: { code: error.code, message: error.message, ...(details ? { details } : {}) } },
      }
    }
  }
  const client = clientErrorOf(error)
  if (client) return client
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } } }
}

/** Neutral code and fixed message for the 4xx statuses frameworks raise themselves. */
const CLIENT_ERRORS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Malformed request.' },
  404: { code: 'NOT_FOUND', message: 'Route not found.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' },
  406: { code: 'NOT_ACCEPTABLE', message: 'Not acceptable.' },
  408: { code: 'REQUEST_TIMEOUT', message: 'Request timeout.' },
  411: { code: 'LENGTH_REQUIRED', message: 'Length required.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
  414: { code: 'URI_TOO_LONG', message: 'Request URI is too long.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests — slow down.' },
  431: { code: 'HEADERS_TOO_LARGE', message: 'Request headers are too large.' },
}

/**
 * A client error raised by the HTTP framework itself — Fastify's body parser
 * (`FST_*` codes: malformed JSON, body too large, unsupported content type), a
 * body parser's `SyntaxError` explicitly tagged with a 4xx `statusCode` (the
 * Fastify adapter's JSON parser), or an http-errors style error that marks
 * itself `expose: true` (body-parser).
 * Those used to become a 500 INTERNAL_ERROR: the client got the wrong status
 * and every malformed request was logged and alerted on as a server bug.
 *
 * Deliberately NOT honoured: any other error that merely carries a `status` or
 * `statusCode` — a failed upstream SDK call (`401 Invalid API key`) is a bug in
 * this server, not the caller's fault, and must stay a 500. The framework's own
 * message is never echoed (it can quote the offending input).
 */
export function clientErrorOf(error: unknown): ErrorResponse | null {
  if (!error || typeof error !== 'object') return null
  const e = error as { code?: unknown; statusCode?: unknown; status?: unknown; expose?: unknown }
  const fromFramework =
    (typeof e.code === 'string' && e.code.startsWith('FST_')) ||
    (error instanceof SyntaxError && typeof e.statusCode === 'number')
  if (!fromFramework && e.expose !== true) return null
  const status = typeof e.statusCode === 'number' ? e.statusCode : e.status
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) return null
  const known = CLIENT_ERRORS[status] ?? { code: 'BAD_REQUEST', message: 'Bad request.' }
  return { status, body: { error: { ...known } } }
}
