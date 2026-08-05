import { randomUUID } from 'node:crypto'
import {
  Container,
  createToken,
  definePlugin,
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
    /** Escopo DI da request — instâncias `scoped` vivem aqui. */
    container?: Container
  }
}

export const FASTIFY = createToken<FastifyInstance>('fastify')

export interface FastifyPluginOptions {
  routes?: MachizeRoute[]
  /** Opções repassadas ao construtor do Fastify (logger, trustProxy…). */
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
      registerRoutes(container.get(FASTIFY), options.routes ?? [], container)
    },
    async shutdown({ container }) {
      await container.get(FASTIFY).close()
    },
  })
}

/** Registra rotas Machize numa instância Fastify (usável também sem o plugin). */
export function registerRoutes(
  instance: FastifyInstance,
  routes: MachizeRoute[],
  container?: Container,
): void {
  for (const definition of routes) {
    instance.route({
      method: definition.method,
      url: definition.url,
      handler: wrapHandler(definition, container),
    })
  }
}

function wrapHandler(definition: MachizeRoute, container?: Container) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = headerValue(request, 'x-request-id') ?? randomUUID()
    const context: RequestContext = {
      requestId,
      correlationId: headerValue(request, 'x-correlation-id') ?? requestId,
      ...(container ? { container: container.createScope() } : {}),
    }
    void reply.header('x-request-id', requestId)

    return runWithContext(context, async () => {
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
  if (error instanceof HttpError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } })
  }
  // erro não intencional: loga com stack, responde sem vazar detalhes
  request.log.error(error)
  return reply.code(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor.' },
  })
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}
