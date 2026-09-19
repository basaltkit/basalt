import { Container, createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import {
  NOT_FOUND_RESPONSE,
  HttpServerCollector,
  HTTP_SERVER,
  runRoute,
  toErrorResponse,
  reportHttpError,
  type HttpErrorReporter,
  type HttpReply,
  type HttpRequest,
  type BasaltRoute,
  type RequestEnricher,
  type RouteGuard,
  isSseResponse,
  sseProducerOf,
  driveSse,
  SSE_HEADERS,
  GUARDED_META_BUCKET,
  assertRoutesGuarded,
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

type Register = (path: string, handler: (req: Request, res: Response, next: NextFunction) => unknown) => void

/**
 * Maps an error raised outside the route pipeline (body-parser, a pre-hook,
 * an edge route) to the neutral envelope. Body-parser errors keep their 4xx
 * status with a fixed message; everything else goes through `toErrorResponse`,
 * so no stack, path or driver message ever reaches the client.
 */
function toMiddlewareErrorResponse(error: unknown): ReturnType<typeof toErrorResponse> {
  const status =
    (error as { status?: unknown; statusCode?: unknown } | null)?.status ??
    (error as { statusCode?: unknown } | null)?.statusCode
  // body-parser raises http-errors: a string `type` and/or `expose: true`.
  const { type, expose } = (error ?? {}) as {
    type?: unknown
    expose?: unknown
  }
  const fromBodyParser = typeof type === 'string' || expose === true
  // The router raises a 400 URIError for a path parameter that is not valid
  // percent-encoding (`/items/%E0%A4%A`): a client error, not a server bug.
  const fromRouter = error instanceof URIError
  if (typeof status === 'number' && status >= 400 && status < 500 && (fromBodyParser || fromRouter)) {
    if (status === 413) {
      return {
        status,
        body: {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body is too large.',
          },
        },
      }
    }
    if (status === 415) {
      return {
        status,
        body: {
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'Unsupported request body encoding.',
          },
        },
      }
    }
    const message = fromRouter ? 'Malformed request path.' : 'Malformed request body.'
    return { status: 400, body: { error: { code: 'BAD_REQUEST', message } } }
  }
  return toErrorResponse(error)
}

/**
 * Reports a failed request without ever letting the reporter itself break the
 * response: a throwing `onError` would otherwise reach Express's finalhandler
 * (an HTML page with the reporter's stack and message) or, on Express 4, an
 * unhandled rejection.
 */
function reportSafely(onError: HttpErrorReporter | undefined, entry: Parameters<HttpErrorReporter>[0]): void {
  try {
    if (onError) onError(entry)
    else reportHttpError(entry)
  } catch {
    /* a broken reporter must not change what the client receives */
  }
}

function basaltHandler(
  definition: BasaltRoute,
  container: Container | undefined,
  enrichers: RequestEnricher[],
  guards: RouteGuard[],
  onError?: HttpErrorReporter,
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
      // This adapter previously reported nothing at all — a 500 reached the
      // client and left no trace whatsoever on the server.
      reportSafely(onError, {
        error,
        status,
        code: body.error.code,
        method: req.method,
        url: req.originalUrl,
      })
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
  onError?: HttpErrorReporter,
): void {
  const router = app as unknown as Record<string, Register>
  for (const definition of routes) {
    router[definition.method.toLowerCase()]!(
      definition.url,
      basaltHandler(definition, container, enrichers, guards, onError),
    )
  }
}

export interface ExpressPluginOptions {
  routes?: BasaltRoute[]
  /**
   * Waives the boot-time check that every route declaring security meta
   * (`auth`, `can`, `teamRole`) has a registered guard enforcing it. Pass
   * `true` to waive everything (e.g. authentication handled at an outer
   * edge/gateway), or an array of specific keys. Default: fail loud at boot.
   */
  allowUnguardedMeta?: boolean | string[]
  /** Bring your own Express app; otherwise one is created with `express.json()`. */
  app?: Express
  /**
   * Serve the neutral JSON body (`NOT_FOUND_RESPONSE` from @basaltkit/http)
   * for unmatched routes, identical across all adapters, instead of Express's
   * HTML default. Default: true. Pass false to keep Express's own handling
   * (e.g. when the app mounts its own catch-all after boot).
   */
  /**
   * Where failed requests are reported. Default: 5xx via `console.error` (with
   * the stack) and 4xx via `console.warn`, prefixed `[basalt:http]`. Pass your
   * own to route them into a real logger, or `() => {}` to silence them.
   */
  onError?: HttpErrorReporter
  notFound?: boolean
  /**
   * Mount a final error middleware that turns errors raised outside a route
   * (malformed/oversized bodies, a failing pre-hook) into the neutral JSON
   * envelope instead of Express's default HTML page, which includes the stack
   * trace unless `NODE_ENV=production`. Default: true. Pass false only if you
   * mount your own `(err, req, res, next)` handler after boot.
   */
  errorHandler?: boolean
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
      // Fail loud BEFORE traffic if a route declares security meta (auth/can/
      // teamRole) that no registered guard enforces — it would serve open.
      assertRoutesGuarded(
        routes,
        new Set(metadata.get<string>(GUARDED_META_BUCKET)),
        options.allowUnguardedMeta,
      )
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
        const preHooked = new WeakSet<Request>()
        app.use(async (req: Request, res: Response, next: NextFunction) => {
          preHooked.add(req)
          try {
            const reply = new ExpressReply(res)
            if (await collector.runPre(toNeutralRequest(req), reply)) return
          } catch (error) {
            // Express 4 does not catch a rejected async middleware.
            return next(error)
          }
          next()
        })
        registerRoutes(app, routes, container, enrichers, guards, options.onError)
        for (const { method, url, handler } of collector.extraRoutes) {
          router[method.toLowerCase()]!(url, async (req: Request, res: Response, next: NextFunction) => {
            try {
              const reply = new ExpressReply(res)
              const result = await handler({
                request: toNeutralRequest(req),
                reply,
              })
              if (!reply.sent) reply.send(result)
            } catch (error) {
              next(error)
            }
          })
        }
        // Mounted last, so anything unmatched gets the neutral JSON 404
        // instead of Express's HTML default.
        if (options.notFound !== false) {
          app.use((_req: Request, res: Response) => {
            if (!res.headersSent) res.status(404).json(NOT_FOUND_RESPONSE)
          })
        }
        if (options.errorHandler !== false) {
          app.use(async (error: unknown, req: Request, res: Response, next: NextFunction) => {
            if (res.headersSent) return next(error)
            const { status, body } = toMiddlewareErrorResponse(error)
            reportSafely(options.onError, {
              error,
              status,
              code: body.error.code,
              method: req.method,
              url: req.originalUrl,
            })
            // A body-parser failure happens before the pre-hooks ran: run them
            // (with no body) so the error carries the same security/CORS
            // headers and still counts against the rate limit.
            if (!preHooked.has(req)) {
              preHooked.add(req)
              try {
                req.body = undefined
                if (await collector.runPre(toNeutralRequest(req), new ExpressReply(res))) return
              } catch {
                /* already failing — answer with the original error */
              }
            }
            if (!res.headersSent) res.status(status).json(body)
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
