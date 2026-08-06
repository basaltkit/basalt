import { createToken } from '@machize/core'
import type { HttpMethod, HttpReply, HttpRequest } from './route.js'

/** Middleware before routing. If it sends the reply, routing is skipped. */
export type PreHook = (info: { request: HttpRequest; reply: HttpReply }) => void | Promise<void>

/** Runs after the response is produced — for metrics, tracing, etc. */
export type AfterHook = (info: {
  request: HttpRequest
  reply: HttpReply
  statusCode: number
  durationMs: number
}) => void | Promise<void>

/** A standalone route registered by an edge plugin (health, metrics, openapi). */
export type SimpleHandler = (info: { request: HttpRequest; reply: HttpReply }) => unknown

/**
 * The framework-neutral server surface edge plugins target instead of a
 * specific framework. Each adapter (Fastify/Express/Hono) registers an
 * implementation under {@link HTTP_SERVER}; a plugin resolving it works on all
 * three unchanged.
 */
export interface HttpServer {
  /** Register pre-routing middleware (rate limit, CORS, security headers, tracing start). */
  use(hook: PreHook): void
  /** Register a post-response hook (metrics, tracing end). */
  after(hook: AfterHook): void
  /** Register a standalone route (e.g. `/livez`, `/metrics`, `/openapi.json`). */
  addRoute(method: HttpMethod, url: string, handler: SimpleHandler): void
}

export const HTTP_SERVER = createToken<HttpServer>('http:server')

/**
 * Collects hooks and routes registered by edge plugins, for an adapter to wire
 * into its framework at mount time. Adapters register one of these as
 * {@link HTTP_SERVER} and read the buffers when they mount.
 */
export class HttpServerCollector implements HttpServer {
  readonly preHooks: PreHook[] = []
  readonly afterHooks: AfterHook[] = []
  readonly extraRoutes: { method: HttpMethod; url: string; handler: SimpleHandler }[] = []

  use(hook: PreHook): void {
    this.preHooks.push(hook)
  }
  after(hook: AfterHook): void {
    this.afterHooks.push(hook)
  }
  addRoute(method: HttpMethod, url: string, handler: SimpleHandler): void {
    this.extraRoutes.push({ method, url, handler })
  }

  /** Runs pre-hooks in order; resolves true if one of them sent the reply. */
  async runPre(request: HttpRequest, reply: HttpReply): Promise<boolean> {
    for (const hook of this.preHooks) {
      await hook({ request, reply })
      if (reply.sent) return true
    }
    return false
  }

  async runAfter(request: HttpRequest, reply: HttpReply, statusCode: number, durationMs: number): Promise<void> {
    for (const hook of this.afterHooks) await hook({ request, reply, statusCode, durationMs })
  }
}
