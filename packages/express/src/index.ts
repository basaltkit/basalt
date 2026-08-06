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
import express, { type Express, type Request, type Response } from 'express'

export const EXPRESS = createToken<Express>('express')

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

function handlerFor(
  definition: MachizeRoute,
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
) {
  return async (req: Request, res: Response): Promise<void> => {
    const request: HttpRequest = {
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
      params: req.params as Record<string, string>,
      query: req.query,
      body: req.body,
      ...(req.ip ? { ip: req.ip } : {}),
      raw: req,
    }
    const reply = new ExpressReply(res)
    try {
      const result = await runRoute(definition, request, reply, {
        ...(container ? { container } : {}),
        enrichers,
        guards,
      })
      if (!reply.sent) reply.send(result)
    } catch (error) {
      const { status, body } = toErrorResponse(error)
      if (!res.headersSent) res.status(status).json(body)
    }
  }
}

/** Mounts Machize routes on an Express app (usable without the plugin). */
export function registerRoutes(
  app: Express,
  routes: MachizeRoute[],
  container?: Container,
  enrichers: RequestEnricher[] = [],
  guards: RouteGuard[] = [],
): void {
  type Register = (path: string, handler: (req: Request, res: Response) => unknown) => void
  const router = app as unknown as Record<string, Register>
  for (const definition of routes) {
    router[definition.method.toLowerCase()]!(definition.url, handlerFor(definition, container, enrichers, guards))
  }
}

export interface ExpressPluginOptions {
  routes?: MachizeRoute[]
  /** Bring your own Express app; otherwise one is created with `express.json()`. */
  app?: Express
}

/**
 * Runs Machize on Express. The same routes, enrichers and guards you register
 * for Fastify work unchanged — resolve `EXPRESS` for the app to `listen()`.
 */
export function expressPlugin(options: ExpressPluginOptions = {}) {
  return definePlugin({
    name: 'machize:express',
    register({ container }) {
      container.singleton(EXPRESS, () => {
        const app = options.app ?? express()
        app.use(express.json())
        return app
      })
    },
    boot({ container }) {
      const app = container.get(EXPRESS)
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
