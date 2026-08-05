import type { input as ZodInput, output as ZodOutput, ZodType } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * A typed API endpoint — the single source of truth shared by the client
 * (and, later, the server route + OpenAPI). Schemas are Zod, so the input
 * and output types are inferred, not hand-written.
 */
export interface Endpoint<
  B extends ZodType | undefined = ZodType | undefined,
  Q extends ZodType | undefined = ZodType | undefined,
  P extends ZodType | undefined = ZodType | undefined,
  R extends ZodType | undefined = ZodType | undefined,
> {
  method: HttpMethod
  /** Path with `:param` placeholders, e.g. `/projects/:id`. */
  path: string
  body?: B
  query?: Q
  params?: P
  /** Success response schema — validated client-side to catch drift. */
  result?: R
}

/**
 * endpoint({ method: 'POST', path: '/projects', body: z.object({ name: z.string() }),
 *            result: ProjectSchema })
 */
export function endpoint<
  B extends ZodType | undefined = undefined,
  Q extends ZodType | undefined = undefined,
  P extends ZodType | undefined = undefined,
  R extends ZodType | undefined = undefined,
>(spec: {
  method: HttpMethod
  path: string
  body?: B
  query?: Q
  params?: P
  result?: R
}): Endpoint<B, Q, P, R> {
  return spec
}

/** A nested map of endpoints, mirrored by the client (`client.projects.create`). */
export interface EndpointTree {
  [key: string]: Endpoint<ZodType | undefined, ZodType | undefined, ZodType | undefined, ZodType | undefined> | EndpointTree
}

// --- type inference ------------------------------------------------------

type FromInput<K extends string, S> = S extends ZodType ? { [P in K]: ZodInput<S> } : Record<never, never>
type FromOutput<K extends string, S> = S extends ZodType ? { [P in K]: ZodOutput<S> } : Record<never, never>

/**
 * The call input for an endpoint. `body` uses the schema's INPUT type (so
 * defaults/optionals can be omitted); `query`/`params` use the OUTPUT type
 * (the coerced, developer-friendly value the caller provides).
 */
export type EndpointInput<E> = E extends Endpoint<infer B, infer Q, infer P, ZodType | undefined>
  ? FromInput<'body', B> & FromOutput<'query', Q> & FromOutput<'params', P>
  : never

export type EndpointOutput<E> = E extends Endpoint<
  ZodType | undefined,
  ZodType | undefined,
  ZodType | undefined,
  infer R
>
  ? R extends ZodType
    ? ZodOutput<R>
    : unknown
  : never

/** Input is optional when the endpoint declares no body/query/params. */
type CallArgs<E> = keyof EndpointInput<E> extends never
  ? [input?: EndpointInput<E>]
  : [input: EndpointInput<E>]

export type Client<T> = {
  [K in keyof T]: T[K] extends Endpoint<
    ZodType | undefined,
    ZodType | undefined,
    ZodType | undefined,
    ZodType | undefined
  >
    ? (...args: CallArgs<T[K]>) => Promise<EndpointOutput<T[K]>>
    : Client<T[K]>
}
