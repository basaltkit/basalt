import { Container, createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import {
  NOT_FOUND_RESPONSE,
  HttpServerCollector,
  HTTP_SERVER,
  runRoute,
  toErrorResponse,
  reportHttpError,
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
  for (const definition of routes) {
    instance.route({
      method: definition.method,
      url: definition.url,
      handler: wrapHandler(definition, container, enrichers, guards, onError),
    })
  }
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
      const result = await runRoute(
        definition,
        toNeutralRequest(request),
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
  return typeof log.level === 'string' ? (request.log as unknown as HttpLogSink) : console
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
