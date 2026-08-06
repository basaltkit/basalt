import { Container, createToken, definePlugin, ensureMetadata } from '@machize/core'
import {
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

export interface FastifyPluginOptions {
  routes?: MachizeRoute[]
  /** Options forwarded to the Fastify constructor (logger, trustProxy…). */
  fastify?: FastifyServerOptions
}

export function fastifyPlugin(options: FastifyPluginOptions = {}) {
  return definePlugin({
    name: 'machize:fastify',
    register({ container }) {
      container.singleton(FASTIFY, () => {
        const instance = Fastify(options.fastify ?? {})
        instance.setErrorHandler(errorHandler)
        return instance
      })
    },
    boot({ container }) {
      const routes = options.routes ?? []
      const metadata = ensureMetadata(container)
      const enrichers = metadata.get<RequestEnricher>('http:enrichers')
      const guards = metadata.get<RouteGuard>('http:guards')
      registerRoutes(container.get(FASTIFY), routes, container, enrichers, guards)
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

function wrapHandler(
  definition: MachizeRoute,
  container?: Container,
  enrichers: RequestEnricher[] = [],
  guards: RouteGuard[] = [],
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const httpRequest: HttpRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      params: (request.params ?? {}) as Record<string, string>,
      query: request.query,
      body: request.body,
      ip: request.ip,
      raw: request,
    }
    return runRoute(definition, httpRequest, reply as unknown as HttpReply, {
      ...(container ? { container } : {}),
      enrichers,
      guards,
    })
  }
}

function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  const { status, body } = toErrorResponse(error)
  // unintentional errors: log with stack, respond without leaking details
  if (status === 500) request.log.error(error)
  return reply.code(status).send(body)
}
