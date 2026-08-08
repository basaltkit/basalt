import { Container, createToken, definePlugin, ensureMetadata } from '@machize/core'
import {
  HttpServerCollector,
  HTTP_SERVER,
  runRoute,
  toErrorResponse,
  type HttpReply,
  type HttpRequest,
  type MachizeRoute,
  type RequestEnricher,
  type RouteGuard,
} from '@machize/http'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'

// The request pipeline (validation, enrichers, guards, error mapping) lives in
// @machize/http, shared with the Express and Hono adapters. This module only
// adapts Fastify's request/reply to the neutral shape.
export type { RequestEnricher, RouteGuard } from '@machize/http'

declare module '@machize/core' {
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
  routes?: MachizeRoute[]
  /** Options forwarded to the Fastify constructor (logger, trustProxy…). */
  fastify?: FastifyServerOptions
}

export function fastifyPlugin(options: FastifyPluginOptions = {}) {
  const collector = new HttpServerCollector()
  return definePlugin({
    name: 'machize:fastify',
    register({ container }) {
      container.singleton(FASTIFY, () => {
        const instance = Fastify(options.fastify ?? {})
        instance.setErrorHandler(errorHandler)
        // Fastify's default JSON parser throws on an empty body — but a POST to a
        // bodiless route (e.g. an @machize/sdk call with no payload) still sends
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
              ;(error as FastifyError).statusCode = 400
              done(error as Error)
            }
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
      const instance = container.get(FASTIFY)
      registerRoutes(instance, routes, container, enrichers, guards)
      // Mount edge-plugin hooks/routes once every plugin has registered them.
      hooks.on('app:booted', () => mountCollector(instance, collector))
      // Expose routes to tooling (CLI `mach routes`, OpenAPI, SDK). The Zod
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

/** Registers Machize routes on a Fastify instance (also usable without the plugin). */
export function registerRoutes(
  instance: FastifyInstance,
  routes: MachizeRoute[],
  container?: Container,
  enrichers: RequestEnricher[] = [],
  guards: RouteGuard[] = [],
): void {
  for (const definition of routes) {
    instance.route({
      method: definition.method,
      url: definition.url,
      handler: wrapHandler(definition, container, enrichers, guards),
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
  definition: MachizeRoute,
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
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

      if (!neutralReply.sent) {
        neutralReply.send(result)
      }
    } catch (error) {
      const { status, body } = toErrorResponse(error)

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

function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  const { status, body } = toErrorResponse(error)
  // unintentional errors: log with stack, respond without leaking details
  if (status === 500) request.log.error(error)
  return reply.code(status).send(body)
}
