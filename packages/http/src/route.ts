import type { output as ZodOutput, ZodType } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * Framework-neutral request seen by handlers, enrichers and guards. Adapters
 * (Fastify/Express/Hono) build this from their native request; `raw` is the
 * escape hatch to that native object.
 */
export interface HttpRequest {
  method: string
  /** Full URL path (+ query string). */
  url: string
  /** Header names are lower-cased by every adapter. */
  headers: Record<string, string | string[] | undefined>
  params: Record<string, string>
  query: unknown
  body: unknown
  ip?: string
  /** Matched route template (e.g. `/users/:id`), when the adapter knows it. */
  routePattern?: string
  raw: unknown
}

/**
 * Framework-neutral response. `code().header().send()` is the common surface;
 * `sent` lets the adapter know whether to also emit the handler's return value.
 */
export interface HttpReply {
  code(status: number): this
  header(name: string, value: string): this
  /** Sends the payload; omit it for an empty body (e.g. a 204). */
  send(payload?: unknown): unknown
  readonly sent: boolean
  readonly statusCode: number
  raw: unknown
}

type Infer<S> = S extends ZodType ? ZodOutput<S> : undefined

export interface HandlerArgs<B, Q, P> {
  body: Infer<B>
  query: Infer<Q>
  params: Infer<P>
  request: HttpRequest
  reply: HttpReply
}

export interface BasaltRoute {
  method: HttpMethod
  url: string
  body?: ZodType | undefined
  query?: ZodType | undefined
  params?: ZodType | undefined
  /** Per-status response schemas — feed OpenAPI/SDK (Metadata), not validated at runtime. */
  response?: Record<number, ZodType> | undefined
  /** Free-form metadata read by other plugins (auth, permissions, rate-limit…). */
  meta?: Record<string, unknown> | undefined
  handler: (args: HandlerArgs<ZodType, ZodType, ZodType>) => unknown
}

/**
 * Defines an end-to-end typed route once — it runs unchanged on every adapter
 * (Fastify, Express, Hono). Body/query/params types are INFERRED from the Zod
 * schemas; no manual generics.
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
}): BasaltRoute {
  return config as unknown as BasaltRoute
}
