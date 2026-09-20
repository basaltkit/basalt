import type { Readable } from 'node:stream'
import { Container, createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import {
  NOT_FOUND_RESPONSE,
  HttpServerCollector,
  HTTP_SERVER,
  runRoute,
  toErrorResponse,
  reportHttpError,
  consoleSink,
  type HttpErrorReporter,
  type HttpLogSink,
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
  isRawBody,
  isStreamResponse,
  streamPayloadOf,
  toNodeStream,
  destroyStreamSource,
  type StreamPayload,
} from '@basaltkit/http'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'

// The request pipeline (validation, enrichers, guards, error mapping) lives in
// @basaltkit/http, shared with the Express and Hono adapters. This module only
// adapts Fastify's request/reply to the neutral shape.
export type { RequestEnricher, RouteGuard } from '@basaltkit/http'

declare module '@basaltkit/core' {
  interface RequestContext {
    /** Per-request DI scope — `scoped` instances live here. */
    container?: Container
  }
}

export const FASTIFY = createToken<FastifyInstance>('fastify')

class FastifyReplyAdapter implements HttpReply {
  constructor(private readonly reply: FastifyReply) {}

  get sent(): boolean {
    return this.reply.sent
  }

  get statusCode(): number {
    return this.reply.statusCode
  }

  get raw(): unknown {
    return this.reply
  }

  code(status: number): this {
    this.reply.code(status)
    return this
  }

  header(name: string, value: string): this {
    this.reply.header(name, value)
    return this
  }

  send(payload: unknown): this {
    this.reply.send(payload)
    return this
  }
}
export interface FastifyPluginOptions {
  routes?: BasaltRoute[]
  /**
   * Waives the boot-time check that every route declaring security meta
   * (`auth`, `can`, `teamRole`) has a registered guard enforcing it. Pass
   * `true` to waive everything (e.g. authentication handled at an outer
   * edge/gateway), or an array of specific keys. Default: fail loud at boot.
   */
  allowUnguardedMeta?: boolean | string[]
  /** Options forwarded to the Fastify constructor (logger, trustProxy…). */
  fastify?: FastifyServerOptions
  /**
   * Serve the neutral JSON body (`NOT_FOUND_RESPONSE` from @basaltkit/http)
   * for unmatched routes, identical across all adapters. Default: true.
   * A `setNotFoundHandler` registered during a plugin's boot phase wins (the
   * adapter's set is guarded); to register one after app:booted instead,
   * pass `notFound: false` here — Fastify allows only one handler.
   */
  notFound?: boolean
  /**
   * Where failed requests are reported — 5xx with the stack, 4xx as a one-line
   * warning. Pass your own to route them into a real logger, or `() => {}` to
   * silence them entirely.
   *
   * By default they go to Fastify's own logger, so records stay structured for
   * apps that configured pino, and to the console for apps that did not (a
   * server built with `logger: false`, Fastify's default, installs a no-op
   * logger that would swallow them).
   *
   * Note this is Fastify's logger, not `@basaltkit/logger` — the two are
   * separate, and setting a level on `loggerPlugin` does not affect these.
   */
  onError?: HttpErrorReporter
}

export function fastifyPlugin(options: FastifyPluginOptions = {}) {
  const collector = new HttpServerCollector()
  return definePlugin({
    name: 'basalt:fastify',
    register({ container }) {
      container.singleton(FASTIFY, () => {
        // Anti-slowloris default: cap how long the whole request may take to arrive.
        // Fastify's default is 0 (disabled); a caller-supplied value always wins.
        const instance = Fastify({ requestTimeout: 30_000, ...(options.fastify ?? {}) })
        instance.setErrorHandler(makeErrorHandler(options.onError))
        // Fastify's default JSON parser throws on an empty body — but a POST to a
        // bodiless route (e.g. an @basaltkit/sdk call with no payload) still sends
        // `content-type: application/json` with an empty body, which surfaced as a
        // 500. Treat an empty body as "no body" (undefined); keep strict parsing
        // (and a 400) for actual malformed JSON.
        instance.addContentTypeParser(
          'application/json',
          { parseAs: 'string' },
          (_request: FastifyRequest, body: string, done: (err: Error | null, value?: unknown) => void) => {
            if (body.trim() === '') return done(null, undefined)
            try {
              done(null, JSON.parse(body))
            } catch (error) {
              (error as FastifyError).statusCode = 400
              done(error as Error)
            }
          },
        )
        // HTML forms and the SAML ACS binding post application/x-www-form-urlencoded;
        // parse it into an object so form routes work like JSON routes (Fastify has
        // no default parser for it).
        instance.addContentTypeParser(
          'application/x-www-form-urlencoded',
          { parseAs: 'string' },
          (_request: FastifyRequest, body: string, done: (err: Error | null, value?: unknown) => void) => {
            done(null, body ? Object.fromEntries(new URLSearchParams(body)) : undefined)
          },
        )
        return instance
      })
      container.singleton(HTTP_SERVER, () => collector)
    },
    boot({ container, hooks }) {
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
      const instance = container.get(FASTIFY)
      registerRoutes(instance, routes, container, enrichers, guards, options.onError)
      // Mount edge-plugin hooks/routes once every plugin has registered them.
      hooks.on('app:booted', () => {
        mountCollector(instance, collector)
        if (options.notFound !== false) {
          try {
            instance.setNotFoundHandler((_request, reply) => {
              void reply.code(404).send(NOT_FOUND_RESPONSE)
            })
          } catch {
            // The app registered its own not-found handler — keep it.
          }
        }
      })
      // Expose routes to tooling (CLI `basalt routes`, OpenAPI, SDK). The Zod
      // schemas ride along so the OpenAPI generator needs no duplicate wiring.
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
    async shutdown({ container }) {
      await container.get(FASTIFY).close()
    },
  })
}

/** Registers Basalt routes on a Fastify instance (also usable without the plugin). */
export function registerRoutes(
  instance: FastifyInstance,
  routes: BasaltRoute[],
  container?: Container,
  enrichers: RequestEnricher[] = [],
  guards: RouteGuard[] = [],
  onError?: HttpErrorReporter,
): void {
  const parsed = routes.filter((definition) => !isRawBody(definition.body))
  const raw = routes.filter((definition) => isRawBody(definition.body))
  if (parsed.some((definition) => isUploadBody(definition.body))) allowMultipartPassthrough(instance)
  for (const definition of parsed) {
    const uploads = isUploadBody(definition.body)
    instance.route({
      method: definition.method,
      url: definition.url,
      ...(uploads ? { config: { [UPLOAD_ROUTE]: true } } : {}),
      handler: wrapHandler(definition, container, enrichers, guards, onError),
    })
  }
  if (raw.length > 0) registerRawRoutes(instance, raw, container, enrichers, guards, onError)
}

/**
 * Mounts the `rawBody()` routes in their own encapsulated Fastify scope.
 *
 * Fastify content-type parsers are per-scope: a child created with `register()`
 * gets a *copy* of the parsers in force, so clearing them there and installing
 * a single pass-through affects these routes and nothing else. The app's own
 * parsers — the adapter's JSON one, `@fastify/multipart`, anything registered
 * by hand — are left exactly as they are, and every other route keeps going
 * through them (a non-JSON body on a JSON route still answers 415).
 *
 * Inside the scope the parser hands the request stream on untouched for ANY
 * content type, so the neutral pipeline reads the bytes itself, after the
 * enrichers and guards have passed. Hooks, decorators and error handlers are
 * inherited from the parent, so these routes behave like every other one.
 */
function registerRawRoutes(
  instance: FastifyInstance,
  routes: BasaltRoute[],
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
  onError?: HttpErrorReporter,
): void {
  void instance.register(async (scope: FastifyInstance) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser(
      '*',
      (_request: FastifyRequest, _payload: unknown, done: (err: Error | null, value?: unknown) => void) => {
        done(null, undefined)
      },
    )
    for (const definition of routes) {
      scope.route({
        method: definition.method,
        url: definition.url,
        handler: wrapHandler(definition, container, enrichers, guards, onError),
      })
    }
  })
}

/** Route-config flag marking an `upload()` route, read by the multipart pass-through parser. */
const UPLOAD_ROUTE = 'basaltUpload'

/**
 * `upload()` routes stream `multipart/form-data` through @basaltkit/http's own
 * parser, so Fastify must NOT consume the body: this content-type parser hands
 * the raw request stream on untouched (the neutral pipeline reads it only
 * after enrichers and guards passed). Any other route still answers 415 to a
 * multipart body, as before. Registered only when an upload route exists, and
 * never over a parser the app registered itself (e.g. `@fastify/multipart`,
 * which also leaves the stream unread).
 */
function allowMultipartPassthrough(instance: FastifyInstance): void {
  if (instance.hasContentTypeParser('multipart/form-data')) return
  instance.addContentTypeParser(
    'multipart/form-data',
    (request: FastifyRequest, _payload: unknown, done: (err: Error | null, value?: unknown) => void) => {
      const config = request.routeOptions?.config as unknown as Record<string, unknown> | undefined
      if (config?.[UPLOAD_ROUTE] === true) return done(null, undefined)
      const error = new Error('Unsupported Media Type') as FastifyError
      ;(error as { code: string }).code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
      ;(error as { statusCode: number }).statusCode = 415
      done(error)
    },
  )
}

function toNeutralRequest(request: FastifyRequest): HttpRequest {
  return {
    method: request.method,
    url: request.originalUrl,
    headers: request.headers,
    params: (request.params ?? {}) as Record<string, string>,
    query: request.query,
    body: request.body,
    ip: request.ip,
    ...(request.routeOptions?.url ? { routePattern: request.routeOptions.url } : {}),
    raw: request,
  }
}

function wrapHandler(
  definition: BasaltRoute,
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
  onError?: HttpErrorReporter,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const neutralReply = new FastifyReplyAdapter(reply)

    try {
      const neutral = toNeutralRequest(request)
      // An upload() route streams the raw body, and a rawBody() route reads it
      // to a capped buffer — both left unread by their pass-through parser.
      if (isUploadBody(definition.body) || isRawBody(definition.body)) neutral.bodyStream = request.raw
      const result = await runRoute(
        definition,
        neutral,
        neutralReply,
        {
          ...(container ? { container } : {}),
          enrichers,
          guards,
        },
      )

      if (isSseResponse(result)) {
        reply.hijack()
        reply.raw.writeHead(200, SSE_HEADERS)
        await driveSse(sseProducerOf(result), {
          write: (frame) => void reply.raw.write(frame),
          end: () => reply.raw.end(),
          onClose: (listener) => request.raw.on('close', listener),
        })
        return
      }
      // Handed back to Fastify rather than sent here: `reply.sent` stays false
      // while a stream is still piping, so sending it inline would let the
      // route's own return value overwrite it with an empty body.
      if (isStreamResponse(result)) return prepareStream(request, reply, streamPayloadOf(result), onError)
      if (!neutralReply.sent) {
        neutralReply.send(result)
      }
    } catch (error) {
      const { status, body } = toErrorResponse(error)
      // This site used to swallow everything, including 500s: an error thrown
      // inside the route pipeline never reached `setErrorHandler` below.
      report(onError, error, status, body.error.code, request)

      if (!reply.sent) {
        reply.code(status).send(body)
      }
    }
  }
}

/**
 * Prepares a `stream()` response and returns the payload for Fastify to send
 * over its own stream path.
 *
 * Fastify pipes a `Readable` payload without buffering, destroys the source
 * when the client disconnects, turns a failure before the first byte into the
 * normal JSON error response, and cuts the connection when one happens after
 * the headers — the only honest ending once bytes are on the wire. Two things
 * are added here: the streaming headers are withdrawn when the source fails
 * before anything was written (otherwise the JSON error would inherit the
 * download's `Content-Type`/`Content-Disposition`), and a late failure is
 * reported to the app's error reporter, which Fastify's own logging bypasses.
 */
function prepareStream(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: StreamPayload,
  onError?: HttpErrorReporter,
): Readable | undefined {
  if (request.method === 'HEAD') {
    // Fastify's auto-generated HEAD route drains a stream payload to discard
    // it and answers `content-length: 0`. Read nothing, and send the same
    // headers a GET would have carried.
    destroyStreamSource(payload.source)
    reply.hijack()
    if (!reply.raw.headersSent) {
      const headers = { ...reply.getHeaders(), ...payload.headers } as Record<string, number | string | string[] | undefined>
      reply.raw.writeHead(payload.status, headers)
    }
    reply.raw.end()
    return undefined
  }
  const body = toNodeStream(payload.source)
  body.on('error', (error: Error) => {
    if (reply.raw.headersSent) {
      report(onError, error, 500, 'STREAM_FAILED', request)
      return
    }
    for (const name of Object.keys(payload.headers)) {
      reply.removeHeader(name)
      reply.raw.removeHeader(name)
    }
  })
  reply.code(payload.status)
  for (const [name, value] of Object.entries(payload.headers)) reply.header(name, value)
  return body
}

/** Applies edge-plugin hooks and routes (from the collector) to the Fastify instance. */
function mountCollector(instance: FastifyInstance, collector: HttpServerCollector): void {
  for (const hook of collector.preHooks) {
    instance.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      await hook({ request: toNeutralRequest(request), reply: reply as unknown as HttpReply })
      if (reply.sent) return reply
      return undefined
    })
  }
  for (const hook of collector.afterHooks) {
    instance.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
      await hook({
        request: toNeutralRequest(request),
        reply: reply as unknown as HttpReply,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      })
    })
  }
  for (const { method, url, handler } of collector.extraRoutes) {
    instance.route({
      method,
      url,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const result = await handler({ request: toNeutralRequest(request), reply: reply as unknown as HttpReply })
        return reply.sent ? undefined : result
      },
    })
  }
}

/**
 * Reports through the caller's reporter, or through Fastify's own logger.
 * Keeping `request.log` as the default sink preserves structured output for
 * apps that configured pino, while the level policy itself stays in
 * @basaltkit/http so all three adapters agree on it.
 */
function report(
  onError: HttpErrorReporter | undefined,
  error: unknown,
  status: number,
  code: string,
  request: FastifyRequest,
): void {
  const entry = { error, status, code, method: request.method, url: request.url }
  if (onError) onError(entry)
  else reportHttpError(entry, sinkFor(request))
}

/**
 * Fastify's own logger when it is real, the console when it is not.
 *
 * Constructed with `logger: false` — Fastify's default, and what a scaffolded
 * Basalt app gets, since neither `create-basalt` nor the playground turns it on
 * — Fastify installs a no-op logger. Writing reports there would discard them
 * silently, so "observable by default" would hold only for apps that had
 * already configured pino: precisely the ones that needed the help least.
 *
 * The no-op logger exposes no `level`; pino always does.
 */
function sinkFor(request: FastifyRequest): HttpLogSink {
  const log = request.log as unknown as { level?: unknown }
  return typeof log.level === 'string' ? (request.log as unknown as HttpLogSink) : consoleSink
}

function makeErrorHandler(onError?: HttpErrorReporter) {
  return function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
    const { status, body } = toErrorResponse(error)
    // Every status is reported now, not only 500 — a 400 the client sees but
    // the server never records is exactly what makes debugging feel blind.
    // The response body still leaks nothing: `toErrorResponse` decides that.
    report(onError, error, status, body.error.code, request)
    return reply.code(status).send(body)
  }
}
