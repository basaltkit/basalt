import { randomUUID } from 'node:crypto'
import {
  Container,
  createToken,
  definePlugin,
  ensureMetadata,
  MachizeError,
  runWithContext,
  type RequestContext,
} from '@machize/core'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify'
import type { ZodType } from 'zod'
import { HttpError, RequestValidationError, type ValidationIssue } from './errors.js'
import type { MachizeRoute } from './route.js'

declare module '@machize/core' {
  interface RequestContext {
    /** Per-request DI scope — `scoped` instances live here. */
    container?: Container
  }
}

export const FASTIFY = createToken<FastifyInstance>('fastify')

/**
 * Runs inside the request context, before validation and the handler.
 * Plugins register enrichers in the 'http:enrichers' metadata bucket —
 * tenancy uses this to resolve and attach the current tenant.
 */
export type RequestEnricher = (info: {
  request: FastifyRequest
  context: RequestContext
  container: Container
}) => void | Promise<void>

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
      const enrichers = ensureMetadata(container).get<RequestEnricher>('http:enrichers')
      registerRoutes(container.get(FASTIFY), routes, container, enrichers)
      // Expose routes to tooling (CLI `mach routes`, docs generator, SDK).
      const metadata = ensureMetadata(container)
      for (const definition of routes) {
        metadata.add('http:routes', {
          method: definition.method,
          url: definition.url,
          meta: definition.meta ?? {},
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
): void {
  for (const definition of routes) {
    instance.route({
      method: definition.method,
      url: definition.url,
      handler: wrapHandler(definition, container, enrichers),
    })
  }
}

function wrapHandler(
  definition: MachizeRoute,
  container?: Container,
  enrichers: RequestEnricher[] = [],
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = headerValue(request, 'x-request-id') ?? randomUUID()
    const context: RequestContext = {
      requestId,
      correlationId: headerValue(request, 'x-correlation-id') ?? requestId,
      ...(container ? { container: container.createScope() } : {}),
    }
    void reply.header('x-request-id', requestId)

    return runWithContext(context, async () => {
      if (container) {
        for (const enrich of enrichers) {
          await enrich({ request, context, container })
        }
      }
      const args = {
        body: parsePart('body', definition.body, request.body),
        query: parsePart('query', definition.query, request.query),
        params: parsePart('params', definition.params, request.params),
        request,
        reply,
      }
      return definition.handler(args as Parameters<MachizeRoute['handler']>[0])
    })
  }
}

function parsePart(
  part: 'body' | 'query' | 'params',
  schema: ZodType | undefined,
  input: unknown,
): unknown {
  if (!schema) return undefined
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
  throw new RequestValidationError(part, issues)
}

function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof RequestValidationError) {
    return reply.code(400).send({
      error: { code: error.code, message: error.message, part: error.part, issues: error.issues },
    })
  }
  // Any MachizeError carrying a numeric `status` maps to that HTTP status —
  // HttpError, tenancy's TENANCY_NOT_RESOLVED (404), auth errors, etc.
  if (error instanceof MachizeError) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number') {
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
  }
  // unintentional error: log with stack, respond without leaking details
  request.log.error(error)
  return reply.code(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
  })
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}
