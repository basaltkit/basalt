import { Container, createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import {
  HttpServerCollector,
  HTTP_SERVER,
  runRoute,
  toErrorResponse,
  type HttpReply,
  type HttpRequest,
  type BasaltRoute,
  type RequestEnricher,
  type RouteGuard,
} from '@basaltkit/http'
import { Hono, type Context, type Next } from 'hono'

export const HONO = createToken<Hono<any>>('hono')

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

async function toNeutralRequest(context: Context): Promise<HttpRequest> {
  return {
    method: context.req.method,
    url: context.req.url,
    headers: Object.fromEntries(context.req.raw.headers.entries()),
    params: context.req.param() as Record<string, string>,
    query: context.req.query(),
    body: await parseBody(context),
    ...(context.req.routePath ? { routePattern: context.req.routePath } : {}),
    raw: context,
  }
}

/** Neutral reply that buffers the response; the handler emits a native Response. */
class HonoReply implements HttpReply {
  private _status = 200
  private _sent = false
  private _payload: unknown
  constructor(readonly context: Context) {}

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
    // Accumulate on the Hono context so headers set in a pre-hook survive to
    // the final response (a separate reply instance builds it).
    this.context.header(name, value)
    return this
  }
  send(payload: unknown): this {
    this._sent = true
    this._payload = payload
    return this
  }
}

function toResponse(reply: HonoReply, payload: unknown): Response {
  const headers = new Headers(reply.context.res?.headers)
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
  definition: BasaltRoute,
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
) {
  return async (context: Context): Promise<Response> => {
    const reply = new HonoReply(context)
    try {
      const result = await runRoute(definition, await toNeutralRequest(context), reply, {
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

/** Mounts Basalt routes on a Hono app (usable without the plugin). */
export function registerRoutes(
  app: Hono<any>,
  routes: BasaltRoute[],
  container?: Container,
  enrichers: RequestEnricher[] = [],
  guards: RouteGuard[] = [],
): void {
  for (const definition of routes) {
    app.on(definition.method, definition.url, handlerFor(definition, container, enrichers, guards))
  }
}

export interface HonoPluginOptions {
  routes?: BasaltRoute[]
  /** Bring your own Hono app; otherwise a fresh one is created. */
  app?: Hono<any>
}

/**
 * Runs Basalt on Hono (Node, Bun, Deno, edge). The same routes, enrichers and
 * guards you register for Fastify work unchanged — resolve `HONO` for the app
 * to serve (e.g. `@hono/node-server` or an edge runtime's `fetch` export).
 */
export function honoPlugin(options: HonoPluginOptions = {}) {
  const collector = new HttpServerCollector()
  return definePlugin({
    name: 'basalt:hono',
    register({ container }) {
      container.singleton(HONO, () => options.app ?? new Hono())
      container.singleton(HTTP_SERVER, () => collector)
    },
    boot({ container, hooks }) {
      const app = container.get(HONO)
      const routes = options.routes ?? []
      const metadata = ensureMetadata(container)
      const enrichers = metadata.get<RequestEnricher>('http:enrichers')
      const guards = metadata.get<RouteGuard>('http:guards')

      // Mount once edge plugins have registered their hooks/routes.
      hooks.on('app:booted', () => {
        if (collector.afterHooks.length) {
          app.use(async (context: Context, next: Next) => {
            const start = Date.now()
            await next()
            await collector.runAfter(await toNeutralRequest(context), new HonoReply(context), context.res.status, Date.now() - start)
          })
        }
        app.use(async (context: Context, next: Next) => {
          const reply = new HonoReply(context)
          if (await collector.runPre(await toNeutralRequest(context), reply)) return toResponse(reply, reply.payload)
          await next()
          return undefined
        })
        registerRoutes(app, routes, container, enrichers, guards)
        for (const { method, url, handler } of collector.extraRoutes) {
          app.on(method, url, async (context: Context) => {
            const reply = new HonoReply(context)
            const result = await handler({ request: await toNeutralRequest(context), reply })
            return toResponse(reply, reply.sent ? reply.payload : result)
          })
        }
      })

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
