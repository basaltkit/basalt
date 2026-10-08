import { Container, createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import {
  NOT_FOUND_RESPONSE,
  HttpServerCollector,
  HTTP_SERVER,
  runRoute,
  toErrorResponse,
  reportHttpError,
  RequestDisposers,
  type HttpErrorReporter,
  type HttpReply,
  type HttpRequest,
  type BasaltRoute,
  type RequestEnricher,
  type RouteGuard,
  isSseResponse,
  sseProducerOf,
  driveSse,
  SSE_HEADERS,
  assertRoutesGuarded,
  isUploadBody,
  isRawBody,
  rawBodyRouteMatcher,
  isStreamResponse,
  streamPayloadOf,
  destroyStreamSource,
  openStreamPump,
  webStreamFrom,
  type SseProducer,
  type StreamPayload,
  DEFAULT_BODY_LIMIT,
  HttpError,
  isJsonMediaType,
  mediaTypeOf,
} from '@basaltkit/http'
import { Hono, type Context, type Next } from 'hono'

export const HONO = createToken<Hono<any>>('hono')

/** Default maximum request body size (1 MiB) — override via honoPlugin({ bodyLimit }). Same value on every adapter. */
export { DEFAULT_BODY_LIMIT }

/** True for a `multipart/form-data` request — its body is never read outside the route handler. */
const isMultipart = (context: Context): boolean =>
  (context.req.header('content-type') ?? '').trimStart().toLowerCase().startsWith('multipart/form-data')

/** The 400 a malformed JSON body gets — the same code Fastify and Express answer with. */
const malformedBody = (): HttpError => new HttpError(400, 'BAD_REQUEST', 'Malformed request body.')

/**
 * Parses the request body for the neutral request. A multipart body is parsed
 * only when `multipart` is true — i.e. in the handler of a route that is not an
 * `upload()` route (bounded by `bodyLimit` first). Pre-hooks and after-hooks
 * never see it, so an `upload()` route's stream is never consumed (or
 * buffered) before the pipeline — enrichers, guards — has run.
 *
 * JSON is recognised by its exact media type (`application/json` or a `+json`
 * type, as on every adapter), never by a substring: `text/plain;
 * application/json` is CORS-safelisted and must not reach a JSON route without
 * a preflight. A malformed JSON body throws a 400 when `strict` (the route
 * handler); the hooks, which never need it, just see no body.
 */
async function parseBody(context: Context, multipart = false, strict = false): Promise<unknown> {
  const method = context.req.method
  if (method === 'GET' || method === 'HEAD') return undefined
  if (!multipart && isMultipart(context)) return undefined
  const contentType = context.req.header('content-type')
  if (isJsonMediaType(contentType)) {
    let text: string
    try {
      text = await context.req.text()
    } catch {
      if (strict) throw malformedBody()
      return undefined
    }
    // An empty body is "no body", as on Fastify and Express.
    if (text.trim() === '') return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      if (strict) throw malformedBody()
      return undefined
    }
  }
  try {
    const type = mediaTypeOf(contentType)
    if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
      return await context.req.parseBody()
    }
    const text = await context.req.text()
    return text || undefined
  } catch {
    return undefined
  }
}

/**
 * The query as Node's `querystring` (Fastify, Express 5) shapes it: a key
 * given once is a string, a repeated key (`?a=1&a=2`) an array of every value
 * — Hono's `query()` would keep only the first.
 */
function queryOf(context: Context): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const [key, values] of Object.entries(context.req.queries())) {
    query[key] = values.length === 1 ? values[0]! : values
  }
  return query
}

/** Path and query string, as `HttpRequest.url` is documented (and as Fastify and Express report it). */
function pathAndQuery(context: Context): string {
  const url = new URL(context.req.url)
  return `${url.pathname}${url.search}`
}

/** Resolves the client address for a request, or `undefined` when unknown. */
export type ClientIpResolver = (context: Context) => string | undefined

/**
 * Default client-address resolution: the transport's socket address, never a
 * client-controlled header. Supports `@hono/node-server` (`env.incoming`) and
 * Bun (`env.requestIP`). Other runtimes (edge, Deno) need `getClientIp`.
 */
export const defaultClientIp: ClientIpResolver = (context) => {
  const env = context.env as
    | {
        incoming?: { socket?: { remoteAddress?: unknown } }
        requestIP?: (request: Request) => { address?: unknown } | null | undefined
      }
    | undefined
  if (!env || typeof env !== 'object') return undefined
  const nodeAddress = env.incoming?.socket?.remoteAddress
  if (typeof nodeAddress === 'string' && nodeAddress) return nodeAddress
  if (typeof env.requestIP === 'function') {
    try {
      const address = env.requestIP(context.req.raw)?.address
      if (typeof address === 'string' && address) return address
    } catch {
      /* not Bun's server object */
    }
  }
  return undefined
}

async function toNeutralRequest(
  context: Context,
  getClientIp: ClientIpResolver = defaultClientIp,
  withBody: boolean | 'route' = true,
): Promise<HttpRequest> {
  const ip = getClientIp(context)
  return {
    method: context.req.method,
    url: pathAndQuery(context),
    headers: Object.fromEntries(context.req.raw.headers.entries()),
    params: context.req.param() as Record<string, string>,
    query: queryOf(context),
    body: withBody ? await parseBody(context, withBody === 'route', withBody === 'route') : undefined,
    ...(ip ? { ip } : {}),
    ...(context.req.routePath ? { routePattern: context.req.routePath } : {}),
    raw: context,
  }
}

/** The 413 body, in the neutral `{ error: { code, message } }` envelope. */
const payloadTooLarge = (bodyLimit: number) => ({
  error: {
    code: 'PAYLOAD_TOO_LARGE',
    message: `Request body exceeds the ${bodyLimit}-byte limit.`,
  },
})

/**
 * Reads the request body with a hard cap on the bytes actually received — a
 * `Content-Length` header alone is not enough (chunked/streamed bodies carry
 * none, and a runtime that does not frame the body on it lets a client send
 * more than it declared). Returns false when the cap is exceeded; otherwise
 * the buffered body replaces `context.req.raw` so every later reader sees the
 * bounded copy.
 */
async function bufferBoundedBody(context: Context, bodyLimit: number): Promise<boolean> {
  const raw = context.req.raw
  if (!raw.body) return true
  const reader = raw.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > bodyLimit) {
      await reader.cancel().catch(() => {})
      return false
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  context.req.raw = new Request(raw, { body })
  return true
}

/** Contexts whose body has already been bounded (by the plugin middleware). */
const boundedBodies = new WeakSet<Context>()

/**
 * Enforces `bodyLimit` on a request: a declared `Content-Length` above it is
 * rejected without reading, and every body is then counted while it is read —
 * the declared length is never trusted to bound the bytes. Returns false when
 * the body is too large. Idempotent per context.
 */
async function enforceBodyLimit(context: Context, bodyLimit: number): Promise<boolean> {
  if (boundedBodies.has(context)) return true
  const length = context.req.header('content-length')
  if (length !== undefined && /^\d+$/.test(length) && Number(length) > bodyLimit) return false
  const method = context.req.method
  // GET/HEAD bodies are never parsed (and a Request cannot carry one).
  if (method !== 'GET' && method !== 'HEAD' && !(await bufferBoundedBody(context, bodyLimit))) return false
  boundedBodies.add(context)
  return true
}

/**
 * Streams an SSE producer as a Response backed by a ReadableStream (Web streams).
 * Headers set before it — by the pre-hooks (CORS, security headers, rate-limit
 * counters) and the pipeline (`x-request-id`) — are kept: without them a
 * cross-origin EventSource fails its CORS check.
 */
function sseResponse(context: Context, producer: SseProducer): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void driveSse(producer, {
        write: (frame) => controller.enqueue(encoder.encode(frame)),
        end: () => {
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        },
        onClose: (listener) => context.req.raw.signal.addEventListener('abort', listener),
      })
    },
  })
  const headers = new Headers(context.res?.headers)
  // `connection` is a hop-by-hop header a web Response may not carry.
  for (const [name, value] of Object.entries(SSE_HEADERS)) if (name !== 'connection') headers.set(name, value)
  return new Response(stream, { headers })
}

/**
 * Renders a `stream()` response as a `Response` backed by a web stream.
 *
 * The first chunk is pulled BEFORE the Response exists, so a source that fails
 * immediately still becomes a normal JSON error (the failure is rethrown into
 * the handler's catch). After that the stream pulls only when the consumer has
 * room — real backpressure — the request's abort signal closes the source, and
 * a mid-stream failure errors the body (a truncated download) instead of
 * appending anything to bytes already sent.
 */
async function streamResponse(
  context: Context,
  payload: StreamPayload,
  onError?: HttpErrorReporter,
): Promise<Response> {
  const headers = new Headers(context.res?.headers)
  for (const [name, value] of Object.entries(payload.headers)) headers.set(name, value)
  if (context.req.method === 'HEAD') {
    // Nothing is read: the source is released and only the headers a GET would
    // have carried are sent.
    destroyStreamSource(payload.source)
    return new Response(null, { status: payload.status, headers })
  }
  const { pump, first } = await openStreamPump(payload.source)
  const body = webStreamFrom(pump, first, (error) => {
    // A read that fails because the source was released on abort is the client
    // leaving, not a broken payload — never report that as a server error.
    if (context.req.raw.signal.aborted) return
    report(onError, {
      error,
      status: 500,
      code: 'STREAM_FAILED',
      method: context.req.method,
      url: pathAndQuery(context),
    })
  })
  // The client disconnecting must release the source even when the runtime
  // never cancels the response body (an in-process `fetch`, an edge worker).
  context.req.raw.signal.addEventListener('abort', () => void pump.close(), { once: true })
  return new Response(body, { status: payload.status, headers })
}

/**
 * Reports a failed request without ever letting the reporter itself break the
 * response.
 */
function report(onError: HttpErrorReporter | undefined, entry: Parameters<HttpErrorReporter>[0]): void {
  try {
    if (onError) onError(entry)
    else reportHttpError(entry)
  } catch {
    /* a broken reporter must not change what the client receives */
  }
}

/** Neutral reply that buffers the response; the handler emits a native Response. */
class HonoReply implements HttpReply {
  private _status = 200
  private _sent = false
  private _payload: unknown
  constructor(readonly context: Context) {}

  get sent(): boolean {
    return this._sent
  }
  get statusCode(): number {
    return this._status
  }
  get payload(): unknown {
    return this._payload
  }
  get raw(): unknown {
    return this.context
  }
  code(status: number): this {
    this._status = status
    return this
  }
  header(name: string, value: string): this {
    // Accumulate on the Hono context so headers set in a pre-hook survive to
    // the final response (a separate reply instance builds it).
    this.context.header(name, value)
    return this
  }
  send(payload: unknown): this {
    this._sent = true
    this._payload = payload
    return this
  }
}

function toResponse(reply: HonoReply, payload: unknown): Response {
  const headers = new Headers(reply.context.res?.headers)
  let body: string | null
  if (payload === undefined || payload === null) {
    body = null
  } else if (typeof payload === 'string') {
    body = payload
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8')
  } else {
    body = JSON.stringify(payload)
    headers.set('content-type', 'application/json')
  }
  return new Response(body, { status: reply.statusCode, headers })
}

/**
 * Hands a streamed `Response` on with the request's disposers wired to the
 * end of its body: they run once the body is fully read, fails, is cancelled
 * by the consumer, or the client aborts — never while bytes are still owed.
 */
function disposeWhenBodyEnds(response: Response, signal: AbortSignal, disposers: RequestDisposers): Response {
  const run = (): void => void disposers.run()
  if (!response.body) {
    run()
    return response
  }
  if (signal.aborted) run()
  else signal.addEventListener('abort', run, { once: true })
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          run()
        } else controller.enqueue(value)
      } catch (error) {
        run()
        controller.error(error)
      }
    },
    cancel(reason) {
      run()
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, headers: response.headers })
}

function handlerFor(
  definition: BasaltRoute,
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
  onError?: HttpErrorReporter,
  getClientIp: ClientIpResolver = defaultClientIp,
  bodyLimit: number = DEFAULT_BODY_LIMIT,
) {
  return async (context: Context): Promise<Response> => {
    const reply = new HonoReply(context)
    // Disposers enrichers return (a leased database client, …): run when the
    // response is complete — at once for a buffered body, at the end of the
    // body for `stream()`/`sse()`.
    let disposers: RequestDisposers | undefined
    let streamed = false
    const disposersOf = (): RequestDisposers =>
      (disposers ??= new RequestDisposers((error) =>
        report(onError, {
          error,
          status: 500,
          code: 'REQUEST_DISPOSER_FAILED',
          method: context.req.method,
          url: pathAndQuery(context),
        }),
      ))
    // An upload() route streams the raw body through the neutral multipart
    // parser, which enforces its own limits — it is never buffered here.
    const uploads = isUploadBody(definition.body)
    // A rawBody() route carries its own cap and must not be read before the
    // guards have run, so the bounded pre-read steps aside for it too.
    const raws = isRawBody(definition.body)
    // Bounded here too, so routes mounted with `registerRoutes()` alone (no
    // plugin middleware in front) never parse an unbounded body.
    if (!uploads && !raws && !(await enforceBodyLimit(context, bodyLimit))) {
      return toResponse(reply.code(413), payloadTooLarge(bodyLimit))
    }
    try {
      const request = await toNeutralRequest(context, getClientIp, uploads || raws ? false : 'route')
      if (uploads && context.req.raw.body) request.bodyStream = context.req.raw.body
      if (raws) {
        // The web Request's own stream, never `c.req.json()`/`parseBody()`:
        // the bytes are the message and a parsed object cannot be un-parsed.
        if (context.req.raw.body) request.bodyStream = context.req.raw.body
        else request.bodyBytes = new Uint8Array(0)
      }
      const result = await runRoute(definition, request, reply, {
        ...(container ? { container } : {}),
        enrichers,
        guards,
        onDispose: (disposer) => disposersOf().add(disposer),
      })
      if (isSseResponse(result) || isStreamResponse(result)) {
        const response = isSseResponse(result)
          ? sseResponse(context, sseProducerOf(result))
          : await streamResponse(context, streamPayloadOf(result), onError)
        if (!disposers) return response
        streamed = true
        return disposeWhenBodyEnds(response, context.req.raw.signal, disposers)
      }
      return toResponse(reply, reply.sent ? reply.payload : result)
    } catch (error) {
      const { status, body } = toErrorResponse(error)
      // This adapter previously reported nothing at all — a 500 reached the
      // client and left no trace whatsoever on the server.
      const entry = {
        error,
        status,
        code: body.error.code,
        method: context.req.method,
        url: pathAndQuery(context),
      }
      report(onError, entry)
      // Built from the context so headers accumulated before the failure
      // (security headers, CORS, x-request-id) are kept on error responses.
      return toResponse(reply.code(status), body)
    } finally {
      if (disposers && !streamed) await disposers.run()
    }
  }
}

/** Mounts Basalt routes on a Hono app (usable without the plugin). */
export function registerRoutes(
  app: Hono<any>,
  routes: BasaltRoute[],
  container?: Container,
  enrichers: RequestEnricher[] = [],
  guards: RouteGuard[] = [],
  onError?: HttpErrorReporter,
  getClientIp: ClientIpResolver = defaultClientIp,
  bodyLimit: number = DEFAULT_BODY_LIMIT,
): void {
  for (const definition of routes) {
    app.on(
      definition.method,
      definition.url,
      handlerFor(definition, container, enrichers, guards, onError, getClientIp, bodyLimit),
    )
  }
}

export interface HonoPluginOptions {
  routes?: BasaltRoute[]
  /**
   * Waives the boot-time check that every route declaring security meta
   * (`auth`, `can`, `teamRole`) has a registered guard enforcing it. Pass
   * `true` to waive everything (e.g. authentication handled at an outer
   * edge/gateway), or an array of specific keys. Default: fail loud at boot.
   * It never waives the route-meta validators plugins register
   * (`META_VALIDATORS_BUCKET`, e.g. teamsPlugin refusing an unknown
   * `meta.teamRole`) — those also run at boot and fail it.
   */
  allowUnguardedMeta?: boolean | string[]
  /** Bring your own Hono app; otherwise a fresh one is created. */
  app?: Hono<any>
  /**
   * Serve the neutral JSON body (`NOT_FOUND_RESPONSE` from @basaltkit/http)
   * for unmatched routes, identical across all adapters, instead of Hono's
   * text default. Default: true. An app calling `hono.notFound(…)` later
   * still wins (Hono keeps the last handler); pass false to opt out entirely.
   */
  /**
   * Where failed requests are reported. Default: 5xx via `console.error` (with
   * the stack) and 4xx via `console.warn`, prefixed `[basalt:http]`. Pass your
   * own to route them into a real logger, or `() => {}` to silence them.
   */
  onError?: HttpErrorReporter
  notFound?: boolean
  /**
   * Maximum request body size in bytes, enforced on the bytes actually read:
   * a declared `Content-Length` above it is rejected up front, and a body
   * without one (chunked/streamed) is counted while buffering and rejected
   * with 413 the moment it crosses the limit. Hono/edge has no default cap,
   * so without this a large upload is unbounded. Default: 1 MiB.
   */
  bodyLimit?: number
  /**
   * Resolves the client address exposed as `request.ip` — the key for
   * per-client rate limiting (`securityPlugin`) and the IP login throttle.
   * Default: the socket address on `@hono/node-server` and Bun; `undefined`
   * elsewhere (a one-time warning is printed, and rate limits then share a
   * single bucket). On an edge runtime or behind a trusted proxy, supply it,
   * e.g. `(c) => c.req.header('cf-connecting-ip')` on Cloudflare. Never read
   * `X-Forwarded-For` unless a proxy you control overwrites it.
   */
  getClientIp?: ClientIpResolver
  /**
   * Install an `app.onError` that turns errors raised outside a route (a
   * failing pre-hook or edge route, an unreadable body) into the neutral JSON
   * envelope and reports them through `onError`, instead of Hono's plain-text
   * 500. Default: true. Pass false only if you install your own `onError`
   * (Hono keeps one handler; the last call wins).
   */
  errorHandler?: boolean
}

/**
 * Runs Basalt on Hono (Node, Bun, Deno, edge). The same routes, enrichers and
 * guards you register for Fastify work unchanged — resolve `HONO` for the app
 * to serve (e.g. `@hono/node-server` or an edge runtime's `fetch` export).
 */
export function honoPlugin(options: HonoPluginOptions = {}) {
  const collector = new HttpServerCollector()
  return definePlugin({
    name: 'basalt:hono',
    register({ container }) {
      container.singleton(HONO, () => options.app ?? new Hono())
      container.singleton(HTTP_SERVER, () => collector)
    },
    boot({ container, hooks }) {
      const app = container.get(HONO)
      const routes = options.routes ?? []
      const metadata = ensureMetadata(container)
      const enrichers = metadata.get<RequestEnricher>('http:enrichers')
      const guards = metadata.get<RouteGuard>('http:guards')
      // Fail loud BEFORE traffic if a route declares security meta (auth/can/
      // teamRole) that no registered guard enforces — it would serve open —
      // or meta a plugin's validator refuses (e.g. an unknown teamRole).
      assertRoutesGuarded(routes, container, options.allowUnguardedMeta)

      // Mount once edge plugins have registered their hooks/routes.
      const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT
      const customIp = options.getClientIp
      let warnedNoIp = false
      const getClientIp: ClientIpResolver = (context) => {
        const ip = (customIp ?? defaultClientIp)(context)
        if (ip === undefined && !warnedNoIp) {
          warnedNoIp = true
          console.warn(
            '[basalt:hono] Could not resolve the client IP (request.ip is undefined): rate limits share one bucket ' +
              'and the IP login throttle is off. Pass honoPlugin({ getClientIp }) for this runtime.',
          )
        }
        return ip
      }
      // Paths whose body must reach the handler untouched and unread until the
      // guards have passed — the middleware below would otherwise buffer it
      // (the bounded pre-read) or consume it outright (`c.req.json()` while
      // building the neutral request for the pre/after hooks).
      const rawBodyPath = rawBodyRouteMatcher(routes)
      const isRawBodyPath = (context: Context): boolean => rawBodyPath(context.req.method, context.req.path)
      /** The neutral request for a hook: never with the body of a rawBody() route. */
      const hookRequest = (context: Context, withBody = true) =>
        toNeutralRequest(context, getClientIp, withBody && !isRawBodyPath(context))
      hooks.on('app:booted', () => {
        // Bound the body on the bytes read, not only the declared length
        // (Hono/edge has no default cap). Runs before anything parses it.
        app.use(async (context: Context, next: Next) => {
          // A multipart body is bounded where it is read: by the route handler
          // (bodyLimit) or, for an upload() route, by its own streaming limits.
          if (isMultipart(context)) return next()
          // Same for a rawBody() route: its own `maxBytes` bounds it, inside
          // the pipeline, after the guards.
          if (isRawBodyPath(context)) return next()
          const tooLarge = !(await enforceBodyLimit(context, bodyLimit))
          if (tooLarge) {
            // Run the pre-hooks (without a body) so the 413 carries the same
            // security/CORS headers — and counts against the rate limit.
            const reply = new HonoReply(context)
            if (await collector.runPre(await hookRequest(context, false), reply)) {
              return toResponse(reply, reply.payload)
            }
            return toResponse(reply.code(413), payloadTooLarge(bodyLimit))
          }
          return next()
        })
        if (collector.afterHooks.length) {
          app.use(async (context: Context, next: Next) => {
            const start = Date.now()
            await next()
            // The response is already built: a failing after-hook is reported,
            // never turned into a 500 that replaces it.
            try {
              await collector.runAfter(
                await hookRequest(context),
                new HonoReply(context),
                context.res.status,
                Date.now() - start,
              )
            } catch (error) {
              report(options.onError, {
                error,
                status: 500,
                code: 'AFTER_HOOK_FAILED',
                method: context.req.method,
                url: pathAndQuery(context),
              })
            }
          })
        }
        app.use(async (context: Context, next: Next) => {
          const reply = new HonoReply(context)
          if (await collector.runPre(await hookRequest(context), reply)) {
            return toResponse(reply, reply.payload)
          }
          await next()
          return undefined
        })
        registerRoutes(app, routes, container, enrichers, guards, options.onError, getClientIp, bodyLimit)
        // Neutral JSON 404 (an app's own later `notFound` call replaces it).
        if (options.notFound !== false) {
          app.notFound((context: Context) => context.json(NOT_FOUND_RESPONSE, 404))
        }
        // Errors raised outside a route handler — a failing pre-hook, an edge
        // route, reading the body — get the neutral JSON envelope and reach
        // the reporter, as on Fastify and Express. Hono's default is a plain
        // text 500 nobody logs. An `HTTPException` thrown by the app's own Hono
        // middleware keeps the response it carries.
        if (options.errorHandler !== false) {
          app.onError((error: unknown, context: Context) => {
            const own = (error as { getResponse?: unknown } | null)?.getResponse
            if (typeof own === 'function') return (own as () => Response).call(error)
            const { status, body } = toErrorResponse(error)
            report(options.onError, {
              error,
              status,
              code: body.error.code,
              method: context.req.method,
              url: pathAndQuery(context),
            })
            // Built from the context, so headers a pre-hook set before failing
            // (security headers, CORS) are kept.
            return toResponse(new HonoReply(context).code(status), body)
          })
        }
        for (const { method, url, handler } of collector.extraRoutes) {
          app.on(method, url, async (context: Context) => {
            const reply = new HonoReply(context)
            const result = await handler({
              request: await toNeutralRequest(context, getClientIp),
              reply,
            })
            return toResponse(reply, reply.sent ? reply.payload : result)
          })
        }
      })

      for (const definition of routes) {
        metadata.add('http:routes', {
          method: definition.method,
          url: definition.url,
          meta: definition.meta ?? {},
          body: definition.body,
          query: definition.query,
          params: definition.params,
          response: definition.response,
        })
      }
    },
  })
}
