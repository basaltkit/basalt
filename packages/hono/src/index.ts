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
import { Hono, type Context } from 'hono'

export const HONO = createToken<Hono<any>>('hono')

/** Neutral reply that buffers the response; the handler emits a native Response. */
class HonoReply implements HttpReply {
  private _status = 200
  private _sent = false
  private _payload: unknown
  readonly headers = new Map<string, string>()
  constructor(private readonly context: Context) {}

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
    this.headers.set(name, value)
    return this
  }
  send(payload: unknown): this {
    this._sent = true
    this._payload = payload
    return this
  }
}

async function parseBody(context: Context): Promise<unknown> {
  const method = context.req.method
  if (method === 'GET' || method === 'HEAD') return undefined
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

function toResponse(reply: HonoReply, payload: unknown): Response {
  const headers = new Headers()
  for (const [name, value] of reply.headers) headers.set(name, value)
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
  definition: MachizeRoute,
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
) {
  return async (context: Context): Promise<Response> => {
    const request: HttpRequest = {
      method: context.req.method,
      url: context.req.url,
      headers: Object.fromEntries(context.req.raw.headers.entries()),
      params: context.req.param() as Record<string, string>,
      query: context.req.query(),
      body: await parseBody(context),
      raw: context,
    }
    const reply = new HonoReply(context)
    try {
      const result = await runRoute(definition, request, reply, {
        ...(container ? { container } : {}),
        enrichers,
        guards,
      })
      return toResponse(reply, reply.sent ? reply.payload : result)
    } catch (error) {
      const { status, body } = toErrorResponse(error)
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
}

/** Mounts Machize routes on a Hono app (usable without the plugin). */
export function registerRoutes(
  app: Hono<any>,
  routes: MachizeRoute[],
  container?: Container,
  enrichers: RequestEnricher[] = [],
  guards: RouteGuard[] = [],
): void {
  for (const definition of routes) {
    app.on(definition.method, definition.url, handlerFor(definition, container, enrichers, guards))
  }
}

export interface HonoPluginOptions {
  routes?: MachizeRoute[]
  /** Bring your own Hono app; otherwise a fresh one is created. */
  app?: Hono<any>
}

/**
 * Runs Machize on Hono (Node, Bun, Deno, edge). The same routes, enrichers and
 * guards you register for Fastify work unchanged — resolve `HONO` for the app
 * to serve (e.g. `@hono/node-server` or an edge runtime's `fetch` export).
 */
export function honoPlugin(options: HonoPluginOptions = {}) {
  return definePlugin({
    name: 'machize:hono',
    register({ container }) {
      container.singleton(HONO, () => options.app ?? new Hono())
    },
    boot({ container }) {
      const app = container.get(HONO)
      const routes = options.routes ?? []
      const metadata = ensureMetadata(container)
      registerRoutes(
        app,
        routes,
        container,
        metadata.get<RequestEnricher>('http:enrichers'),
        metadata.get<RouteGuard>('http:guards'),
      )
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
