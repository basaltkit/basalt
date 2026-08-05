import type { FastifyReply, FastifyRequest } from 'fastify'
import type { output as ZodOutput, ZodType } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

type Infer<S> = S extends ZodType ? ZodOutput<S> : undefined

export interface HandlerArgs<B, Q, P> {
  body: Infer<B>
  query: Infer<Q>
  params: Infer<P>
  request: FastifyRequest
  reply: FastifyReply
}

export interface MachizeRoute {
  method: HttpMethod
  url: string
  body?: ZodType | undefined
  query?: ZodType | undefined
  params?: ZodType | undefined
  /** Schemas de resposta por status — alimentam OpenAPI/SDK (Metadata), não validam em runtime. */
  response?: Record<number, ZodType> | undefined
  /** Metadados livres lidos por outros plugins (auth, permissions, rate-limit…). */
  meta?: Record<string, unknown> | undefined
  handler: (args: HandlerArgs<ZodType, ZodType, ZodType>) => unknown
}

/**
 * Define uma rota tipada de ponta a ponta: os tipos de body/query/params do
 * handler são INFERIDOS dos schemas Zod — nada de genéricos manuais.
 */
export function route<
  B extends ZodType | undefined = undefined,
  Q extends ZodType | undefined = undefined,
  P extends ZodType | undefined = undefined,
>(config: {
  method: HttpMethod
  url: string
  body?: B
  query?: Q
  params?: P
  response?: Record<number, ZodType>
  meta?: Record<string, unknown>
  handler: (args: HandlerArgs<B, Q, P>) => unknown
}): MachizeRoute {
  return config as unknown as MachizeRoute
}
