import { Container, createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import {
  NOT_FOUND_RESPONSE,
  HttpServerCollector,
  HTTP_SERVER,
  runRoute,
  toErrorResponse,
  reportHttpError,
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
  GUARDED_META_BUCKET,
  assertRoutesGuarded,
  isUploadBody,
  isStreamResponse,
  streamPayloadOf,
  destroyStreamSource,
  openStreamPump,
  webStreamFrom,
  type SseProducer,
  type StreamPayload,
} from '@basaltkit/http'
import { Hono, type Context, type Next } from 'hono'

export const HONO = createToken<Hono<any>>('hono')

/** Default maximum request body size (1 MiB) — override via honoPlugin({ bodyLimit }). */
export const DEFAULT_BODY_LIMIT = 1_048_576

/** True for a `multipart/form-data` request — its body is never read outside the route handler. */
const isMultipart = (context: Context): boolean =>
  (context.req.header('content-type') ?? '').trimStart().toLowerCase().startsWith('multipart/form-data')

/**
 * Parses the request body for the neutral request. A multipart body is parsed
 * only when `multipart` is true — i.e. in the handler of a route that is not an
 * `upload()` route (bounded by `bodyLimit` first). Pre-hooks and after-hooks
 * never see it, so an `upload()` route's stream is never consumed (or
 * buffered) before the pipeline — enrichers, guards — has run.
 */
async function parseBody(context: Context, multipart = false): Promise<unknown> {
  const method = context.req.method
  if (method === 'GET' || method === 'HEAD') return undefined
  if (!multipart && isMultipart(context)) return undefined
  const contentType = context.req.header('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) return await context.req.json()
    if (contentType.includes('form')) return await context.req.parseBody()
    const text = await context.req.text()
    return text || undefined
  } catch {
    return undefined
  }
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
    url: context.req.url,
    headers: Object.fromEntries(context.req.raw.headers.entries()),
    params: context.req.param() as Record<string, string>,
    query: context.req.query(),
    body: withBody ? await parseBody(context, withBody === 'route') : undefined,
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

/** Streams an SSE producer as a Response backed by a ReadableStream (Web streams). */
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
  const { connection: _connection, ...headers } = SSE_HEADERS
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
    try {
      const entry = {
        error,
        status: 500,
        code: 'STREAM_FAILED',
        method: context.req.method,
        url: context.req.url,
      }
      if (onError) onError(entry)
      else reportHttpError(entry)
    } catch {
      /* a broken reporter must not change what the client receives */
    }
  })
  // The client disconnecting must release the source even when the runtime
  // never cancels the response body (an in-process `fetch`, an edge worker).
  context.req.raw.signal.addEventListener('abort', () => void pump.close(), { once: true })
  return new Response(body, { status: payload.status, headers })
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
    // An upload() route streams the raw body through the neutral multipart
    // parser, which enforces its own limits — it is never buffered here.
    const uploads = isUploadBody(definition.body)
    // Bounded here too, so routes mounted with `registerRoutes()` alone (no
    // plugin middleware in front) never parse an unbounded body.
    if (!uploads && !(await enforceBodyLimit(context, bodyLimit))) {
      return toResponse(reply.code(413), payloadTooLarge(bodyLimit))
    }
    try {
      const request = await toNeutralRequest(context, getClientIp, uploads ? false : 'route')
      if (uploads && context.req.raw.body) request.bodyStream = context.req.raw.body
      const result = await runRoute(definition, request, reply, {
        ...(container ? { container } : {}),
        enrichers,
        guards,
      })
      if (isSseResponse(result)) return sseResponse(context, sseProducerOf(result))
      if (isStreamResponse(result)) return await streamResponse(context, streamPayloadOf(result), onError)
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
        url: context.req.url,
      }
      try {
        if (onError) onError(entry)
        else reportHttpError(entry)
      } catch {
        /* a broken reporter must not change what the client receives */
      }
      // Built from the context so headers accumulated before the failure
      // (security headers, CORS, x-request-id) are kept on error responses.
      return toResponse(reply.code(status), body)
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
      // teamRole) that no registered guard enforces — it would serve open.
      assertRoutesGuarded(
        routes,
        new Set(metadata.get<string>(GUARDED_META_BUCKET)),
        options.allowUnguardedMeta,
      )

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
      hooks.on('app:booted', () => {
        // Bound the body on the bytes read, not only the declared length
        // (Hono/edge has no default cap). Runs before anything parses it.
        app.use(async (context: Context, next: Next) => {
          // A multipart body is bounded where it is read: by the route handler
          // (bodyLimit) or, for an upload() route, by its own streaming limits.
          if (isMultipart(context)) return next()
          const tooLarge = !(await enforceBodyLimit(context, bodyLimit))
          if (tooLarge) {
            // Run the pre-hooks (without a body) so the 413 carries the same
            // security/CORS headers — and counts against the rate limit.
            const reply = new HonoReply(context)
            if (await collector.runPre(await toNeutralRequest(context, getClientIp, false), reply)) {
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
            await collector.runAfter(
              await toNeutralRequest(context, getClientIp),
              new HonoReply(context),
              context.res.status,
              Date.now() - start,
            )
          })
        }
        app.use(async (context: Context, next: Next) => {
          const reply = new HonoReply(context)
          if (await collector.runPre(await toNeutralRequest(context, getClientIp), reply)) {
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
