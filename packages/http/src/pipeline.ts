import { randomUUID } from 'node:crypto'
import { Container, BasaltError, runWithContext, type RequestContext } from '@basaltkit/core'
import type { ZodType } from 'zod'
import {
  applyDetailsRedactor,
  sanitizeErrorDetails,
  type ErrorDetails,
  type ErrorDetailsRedactor,
} from './error-details.js'
import { HttpError, RequestValidationError, type ValidationIssue, GuardsWithoutContainerError } from './errors.js'
import { computeEtag, ifNoneMatchSatisfied } from './etag.js'
import { idempotencyStageOf, RecordingReply, type IdempotencyTicket } from './idempotency.js'
import { applyRouteHeaders } from './route-headers.js'
import type { HttpReply, HttpRequest, BasaltRoute } from './route.js'
import { isSseResponse } from './sse.js'
import { isStreamResponse } from './stream.js'
import { RawBodySession, rawBodyOptionsOf } from './raw-body.js'
import { UploadSession, uploadOptionsOf } from './upload.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** Per-request DI scope — `scoped` instances live here. */
    container?: Container
    /**
     * Hands a {@link RequestDisposer} to the request: the adapter runs it once
     * the response has really ended, exactly like one an enricher returns.
     * For cleanup that is taken outside an enricher's return value — e.g. a
     * `tenancy:switched` listener leasing a database client. Set by `runRoute`
     * on the request context only (non-enumerable, so a context copied with a
     * spread — `tenancy.run()` — does not inherit it); its presence tells a
     * plugin that the running pipeline honours disposers. Absent outside an
     * HTTP request and on pipelines older than `@basaltkit/http` 2.8.
     */
    onDispose?: (disposer: RequestDisposer) => void
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
  /**
   * The reply, so an enricher that rejects the request can set a response
   * header first (e.g. `WWW-Authenticate` on a refused credential). Optional:
   * a pipeline may run enrichers without one. An enricher that answers the
   * request itself (`reply.send()`) ends it: the remaining enrichers, the
   * guards and the handler do not run.
   */
  reply?: HttpReply
}) => void | RequestDisposer | Promise<void | RequestDisposer>

/**
 * Cleanup an enricher hands back for the end of its request — e.g. returning a
 * leased database client to its pool. The adapter runs it exactly once, after
 * the response has finished, was abandoned by the client (abort/close) or
 * failed, including a streamed (`stream()`) or event-stream (`sse()`) body
 * that outlives the handler — and never before the pipeline (`runRoute`) has
 * settled, so a client abort mid-handler leaves the handler's resource alive
 * until it returns or throws. Disposers run last-registered first.
 */
export type RequestDisposer = () => void | Promise<void>

/**
 * The per-request list of {@link RequestDisposer}s an adapter keeps. `run()`
 * is once-guarded, so it can be wired to every way a response can end
 * ('finish', 'close', an aborted stream). A disposer added AFTER the request
 * already ended (the client went away while an enricher was still awaiting)
 * runs immediately rather than leaking.
 */
export class RequestDisposers {
  private readonly pending: RequestDisposer[] = []
  private done = false

  /** `onError` receives a disposer's failure; it is never rethrown. */
  constructor(private readonly onError?: (error: unknown) => void) {}

  add(disposer: RequestDisposer): void {
    if (this.done) void this.invoke(disposer)
    else this.pending.push(disposer)
  }

  /** True once `run()` was called. */
  get ran(): boolean {
    return this.done
  }

  /** Runs every disposer once, last-registered first. Never throws. */
  async run(): Promise<void> {
    if (this.done) return
    this.done = true
    while (this.pending.length > 0) await this.invoke(this.pending.pop()!)
  }

  private async invoke(disposer: RequestDisposer): Promise<void> {
    try {
      await disposer()
    } catch (error) {
      try {
        this.onError?.(error)
      } catch {
        /* a broken reporter must not break the response */
      }
    }
  }
}

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
  /**
   * Where the disposers enrichers return are handed. Adapters pass one and run
   * the disposers when the response has really ended (a streamed body outlives
   * `runRoute`). Without it, `runRoute` runs them itself when it returns or
   * throws — right for callers whose result is complete at that point.
   */
  onDispose?: (disposer: RequestDisposer) => void
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

  // A `rawBody()` body is the same bargain: nothing is read from the transport
  // until enrichers and guards have all passed, the bytes are handed over
  // untouched, and a body the route never got to read is released.
  const rawOptions = rawBodyOptionsOf(definition.body)
  const rawSession = rawOptions ? new RawBodySession(request, rawOptions) : undefined

  // No sink from the caller: the disposers are run here, when the route is done.
  const local = pipeline.onDispose ? undefined : new RequestDisposers()
  const onDispose = pipeline.onDispose ?? ((disposer: RequestDisposer) => local!.add(disposer))
  // Also reachable from the request context, for cleanup taken outside an
  // enricher's return value. Non-enumerable: a context copied with a spread
  // (tenancy.run()) is a different scope and must not hand work to this one.
  Object.defineProperty(context, 'onDispose', { value: onDispose, enumerable: false })
  // `idempotencyPlugin` (any adapter): where its check runs for this request,
  // if the request is subject to it at all.
  const idempotency = idempotencyStageOf(pipeline.container)
  const placement = idempotency?.placement(definition, request)

  return runWithContext(context, async () => {
    let ticket: IdempotencyTicket | undefined
    // Whether the handler was entered: only its own outcome is recorded for
    // replay. A refusal raised before it (a guard's 401/403, the rate limiter's
    // 429, a validation 400) releases the key, so the retry runs the operation.
    let handlerStarted = false
    try {
      // The route's static headers go on first, so every response it produces
      // carries them — a guard's 401, a validation 400 and a thrown 500 too.
      applyRouteHeaders(definition, reply)
      const scoped = context.container
      // Fail closed: guards that cannot run must never be silently skipped.
      if (!scoped && (pipeline.guards?.length ?? 0) > 0) {
        throw new GuardsWithoutContainerError(
          `${definition.method} ${definition.url}`,
          pipeline.guards?.length ?? 0,
        )
      }
      if (scoped) {
        for (const enrich of pipeline.enrichers ?? []) {
          const disposer = await enrich({ route: definition, request, context, container: scoped, reply })
          if (typeof disposer === 'function') onDispose(disposer)
          // An enricher that answered the request itself (`reply.send()`, e.g.
          // a redirect) ends it here: the guards and the handler must not run
          // behind a response that has already been decided.
          if (reply.sent) return undefined
        }
        if (placement === 'beforeGuards') {
          const begun = await idempotency!.begin(definition, request, reply)
          if (begun === 'replayed') return undefined
          ticket = begun
        }
        for (const guard of pipeline.guards ?? [])
          await guard({ route: definition, request, context, container: scoped, reply })
      }
      const parsedBody = session || rawSession ? undefined : parsePart('body', definition.body, request.body)
      const query = parsePart('query', definition.query, request.query)
      const params = parsePart('params', definition.params, request.params)
      const body = session ? session.open() : rawSession ? await rawSession.read() : parsedBody
      if (placement === 'beforeHandler') {
        const rawBytes = rawSession ? (body as { bytes: Uint8Array }).bytes : undefined
        const begun = await idempotency!.begin(definition, request, reply, rawBytes)
        if (begun === 'replayed') return undefined
        ticket = begun
      }
      // The reservation owner records what the handler sends, to replay it.
      const recorder = ticket ? new RecordingReply(reply) : undefined
      handlerStarted = true
      const result = await definition.handler({
        body,
        query,
        params,
        request,
        reply: recorder ?? reply,
      } as Parameters<BasaltRoute['handler']>[0])
      const final = applyEtag(definition, request, reply, result)
      if (ticket) {
        const owned = ticket
        ticket = undefined // settled here; a failure below must not settle it twice
        await idempotency!.complete(owned, recorder!, final)
      }
      return final
    } catch (error) {
      // A thrown route: record the client error the handler raised, or release
      // the key so a server failure, or a refusal before the handler ran, stays
      // retryable.
      // An upload() body refused while the handler streamed it (too large,
      // malformed, a refused file type) is a refusal of the request, not the
      // handler's outcome: released like the same refusal raised up front.
      if (ticket) {
        if (handlerStarted && !session?.refused(error)) await idempotency!.fail(ticket, toErrorResponse(error))
        else await idempotency!.abandon(ticket)
      }
      throw error
    } finally {
      session?.release(reply)
      rawSession?.release(reply)
      await local?.run()
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
       * `BasaltError` with a numeric `status` other than 500). Absent
       * otherwise — an unexpected exception, or a toolkit 500, never grows one.
       */
      details?: ErrorDetails
    }
  }
}

/** The client-facing message for an error that keeps its own text for the log. */
function neutralMessage(status: number): string {
  if (status === 502) return 'Bad gateway.'
  if (status === 503) return 'Service unavailable.'
  if (status === 504) return 'Gateway timeout.'
  return status >= 500 ? 'Internal server error.' : 'Request failed.'
}

export interface ErrorResponseOptions {
  /**
   * Filters the public `details` before they are placed in the body — e.g.
   * `redactSensitiveDetails`, which masks keys that name a secret. Default:
   * none (the details are sent as sanitised). `@basaltkit/mcp` passes one by
   * default, since its client is a language model.
   */
  redactDetails?: ErrorDetailsRedactor
}

/**
 * Maps a thrown error to a standardized HTTP response — shared by all adapters
 * so error shapes are identical regardless of framework.
 *
 * Only the public channel is ever read: an error's `internalDetails` (see
 * `HttpErrorOptions`) is for the error reporter and never reaches the body.
 */
export function toErrorResponse(error: unknown, options: ErrorResponseOptions = {}): ErrorResponse {
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
      // A 500 raised by the toolkit (a misconfigured pipeline, a UserSource
      // missing a method, a missing policy) is a server bug, and its message
      // was written for the developer — it names options, internals, the fix.
      // Only its code reaches the client; the adapters still report the error
      // itself, message and stack, to the log. Other 5xx statuses (a 503
      // "tenant still provisioning, retry", a 501 "provider cannot do that")
      // are designed for the client and pass through, as does an `HttpError`
      // (thrown deliberately) or an error that sets `expose: true`.
      const expose = (error as { expose?: unknown }).expose
      if (status === 500 && !(error instanceof HttpError) && expose !== true) {
        return { status, body: { error: { code: error.code, message: 'Internal server error.' } } }
      }
      // An error that sets `expose: false` keeps its message and details for
      // the log only, whatever its status: a 502 whose message quotes an
      // upstream provider's reply or the internal host it refused to reach is
      // diagnostic for the operator and an oracle for the client.
      if (expose === false) {
        return { status, body: { error: { code: error.code, message: neutralMessage(status) } } }
      }
      // Sanitised, not passed through: `details` reaches the client verbatim,
      // so it must be plain, acyclic, bounded JSON data or nothing at all.
      const details = applyDetailsRedactor(sanitizeErrorDetails(error.details), options.redactDetails, {
        error,
        status,
        code: error.code,
      })
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
