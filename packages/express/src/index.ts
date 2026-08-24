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
  isSseResponse,
  sseProducerOf,
  driveSse,
  SSE_HEADERS,
} from '@basaltkit/http'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'

export const EXPRESS = createToken<Express>('express')

function toNeutralRequest(req: Request): HttpRequest {
  return {
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    params: req.params as Record<string, string>,
    query: req.query,
    body: req.body,
    ...(req.ip ? { ip: req.ip } : {}),
    ...(req.route?.path ? { routePattern: String(req.route.path) } : {}),
    raw: req,
  }
}

/** Neutral reply backed by an Express `res`. */
class ExpressReply implements HttpReply {
  private _status = 200
  private _sent = false
  constructor(private readonly res: Response) {}

  get sent(): boolean {
    return this._sent
  }
  get statusCode(): number {
    return this._status
  }
  get raw(): unknown {
    return this.res
  }
  code(status: number): this {
    this._status = status
    return this
  }
  header(name: string, value: string): this {
    this.res.setHeader(name, value)
    return this
  }
  send(payload: unknown): this {
    this._sent = true
    this.res.status(this._status)
    if (payload === undefined || payload === null) this.res.end()
    else if (typeof payload === 'string') this.res.send(payload)
    else this.res.json(payload)
    return this
  }
}

type Register = (path: string, handler: (req: Request, res: Response) => unknown) => void

function basaltHandler(
  definition: BasaltRoute,
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
) {
  return async (req: Request, res: Response): Promise<void> => {
    const reply = new ExpressReply(res)
    try {
      const result = await runRoute(definition, toNeutralRequest(req), reply, {
        ...(container ? { container } : {}),
        enrichers,
        guards,
      })
      if (isSseResponse(result)) {
        res.writeHead(200, SSE_HEADERS)
        await driveSse(sseProducerOf(result), {
          write: (frame) => void res.write(frame),
          end: () => res.end(),
          onClose: (listener) => req.on('close', listener),
        })
        return
      }
      if (!reply.sent) reply.send(result)
    } catch (error) {
      const { status, body } = toErrorResponse(error)
      if (!res.headersSent) res.status(status).json(body)
    }
  }
}

/** Mounts Basalt routes on an Express app (usable without the plugin). */
export function registerRoutes(
  app: Express,
  routes: BasaltRoute[],
  container?: Container,
  enrichers: RequestEnricher[] = [],
  guards: RouteGuard[] = [],
): void {
  const router = app as unknown as Record<string, Register>
  for (const definition of routes) {
    router[definition.method.toLowerCase()]!(definition.url, basaltHandler(definition, container, enrichers, guards))
  }
}

export interface ExpressPluginOptions {
  routes?: BasaltRoute[]
  /** Bring your own Express app; otherwise one is created with `express.json()`. */
  app?: Express
}

/**
 * Runs Basalt on Express. The same routes, enrichers, guards and edge plugins
 * you register for Fastify work unchanged — resolve `EXPRESS` for the app to
 * `listen()`.
 */
export function expressPlugin(options: ExpressPluginOptions = {}) {
  const collector = new HttpServerCollector()
  return definePlugin({
    name: 'basalt:express',
    register({ container }) {
      container.singleton(EXPRESS, () => {
        const app = options.app ?? express()
        app.use(express.json())
        // HTML forms and the SAML ACS binding post application/x-www-form-urlencoded.
        app.use(express.urlencoded({ extended: false }))
        return app
      })
      container.singleton(HTTP_SERVER, () => collector)
    },
    boot({ container, hooks }) {
      const app = container.get(EXPRESS)
      const routes = options.routes ?? []
      const metadata = ensureMetadata(container)
      const enrichers = metadata.get<RequestEnricher>('http:enrichers')
      const guards = metadata.get<RouteGuard>('http:guards')
      const router = app as unknown as Record<string, Register>

      // Mount everything once edge plugins have registered their hooks/routes,
      // in the order Express needs: after-hooks → pre-hooks → routes.
      hooks.on('app:booted', () => {
        if (collector.afterHooks.length) {
          app.use((req: Request, res: Response, next: NextFunction) => {
            const start = Date.now()
            res.on('finish', () => {
              void collector.runAfter(toNeutralRequest(req), new ExpressReply(res), res.statusCode, Date.now() - start)
            })
            next()
          })
        }
        app.use(async (req: Request, res: Response, next: NextFunction) => {
          const reply = new ExpressReply(res)
          if (await collector.runPre(toNeutralRequest(req), reply)) return
          next()
        })
        registerRoutes(app, routes, container, enrichers, guards)
        for (const { method, url, handler } of collector.extraRoutes) {
          router[method.toLowerCase()]!(url, async (req: Request, res: Response) => {
            const reply = new ExpressReply(res)
            const result = await handler({ request: toNeutralRequest(req), reply })
            if (!reply.sent) reply.send(result)
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
