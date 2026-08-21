import { definePlugin, ensureMetadata } from '@basaltkit/core'
import type { HttpReply, HttpRequest } from './route.js'
import { HTTP_SERVER } from './server.js'

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
  retryAfterMs: number
}

/**
 * Backing store for the rate limiter (default in-memory; swap `RedisRateLimitStore`
 * to share limits across instances). Methods may be sync or async — the limiter
 * awaits them — so an in-process store stays synchronous while a Redis one doesn't.
 */
export interface RateLimitStore {
  hit(key: string, limit: number, windowMs: number): RateLimitResult | Promise<RateLimitResult>
  reset(key: string): void | Promise<void>
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()
  constructor(private readonly clock: () => number = () => Date.now()) {}

  hit(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.clock()
    let window = this.windows.get(key)
    if (!window || now >= window.resetAt) {
      window = { count: 0, resetAt: now + windowMs }
      this.windows.set(key, window)
    }
    window.count += 1
    return {
      allowed: window.count <= limit,
      limit,
      remaining: Math.max(0, limit - window.count),
      resetAt: window.resetAt,
      retryAfterMs: Math.max(0, window.resetAt - now),
    }
  }
  reset(key: string): void {
    this.windows.delete(key)
  }
}

export interface RateLimitOptions {
  limit: number
  windowMs: number
  store?: RateLimitStore
  key?: (request: HttpRequest) => string
  skip?: (request: HttpRequest) => boolean
}

export interface CorsOptions {
  origin?: boolean | string | string[] | ((origin: string | undefined) => boolean)
  methods?: string[]
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  credentials?: boolean
  maxAge?: number
}

export interface SecurityHeadersOptions {
  hsts?: boolean | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean }
  contentTypeOptions?: boolean
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  referrerPolicy?: string | false
  /**
   * Content-Security-Policy value. Defaults to {@link DEFAULT_CSP} (a lock-down
   * policy fit for a JSON API); pass a string to use your own, or `false` to
   * omit the header entirely.
   */
  contentSecurityPolicy?: string | false
  crossOriginOpenerPolicy?: string | false
}

/** Restrictive default CSP for a JSON API: it renders nothing and frames nothing. */
export const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'"

/**
 * Per-route rate-limit override, read from a route's `meta.rateLimit`. When set,
 * that route gets its own bucket (keyed by client + route) at these thresholds
 * instead of the global default — so login/reset can be stricter than the rest.
 */
export interface RouteRateLimit {
  limit: number
  windowMs: number
}

/** Coerces a route's `meta.rateLimit` into a {@link RouteRateLimit}, or `null` if absent/malformed. */
function parseRouteRateLimit(value: unknown): RouteRateLimit | null {
  if (!value || typeof value !== 'object') return null
  const { limit, windowMs } = value as Record<string, unknown>
  if (typeof limit !== 'number' || typeof windowMs !== 'number') return null
  if (!(limit > 0) || !(windowMs > 0)) return null
  return { limit, windowMs }
}

export interface SecurityPluginOptions {
  rateLimit?: RateLimitOptions | false
  cors?: CorsOptions | false
  headers?: SecurityHeadersOptions | boolean
}

const headerOf = (request: HttpRequest, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}
// Do NOT trust X-Forwarded-For (client-spoofable) for the rate-limit key. Use the
// socket address the adapter sets on `request.ip`; when unknown, share a single
// bucket (fail closed) rather than mint a per-header, spoofable one. Behind a
// trusted proxy, configure the adapter to populate `request.ip` from it.
const clientIp = (request: HttpRequest): string => request.ip ?? 'unknown'

function resolveOrigin(options: CorsOptions, requestOrigin: string | undefined): string | null {
  const option = options.origin
  if (option === undefined || option === true) {
    // Reflecting an arbitrary Origin *with credentials* hands authenticated
    // responses to any site — refuse. Credentials require an explicit allowlist.
    if (options.credentials) return null
    return requestOrigin ?? '*'
  }
  if (option === false) return null
  if (typeof option === 'string') return option
  if (Array.isArray(option)) return requestOrigin && option.includes(requestOrigin) ? requestOrigin : null
  return requestOrigin && option(requestOrigin) ? requestOrigin : null
}

function applyHeaders(reply: HttpReply, options: SecurityHeadersOptions): void {
  const hsts = options.hsts ?? true
  if (hsts) {
    const config = hsts === true ? {} : hsts
    let value = `max-age=${config.maxAge ?? 15_552_000}`
    if (config.includeSubDomains ?? true) value += '; includeSubDomains'
    if (config.preload) value += '; preload'
    reply.header('Strict-Transport-Security', value)
  }
  if (options.contentTypeOptions ?? true) reply.header('X-Content-Type-Options', 'nosniff')
  const frame = options.frameOptions ?? 'DENY'
  if (frame) reply.header('X-Frame-Options', frame)
  const referrer = options.referrerPolicy ?? 'no-referrer'
  if (referrer) reply.header('Referrer-Policy', referrer)
  const coop = options.crossOriginOpenerPolicy ?? 'same-origin'
  if (coop) reply.header('Cross-Origin-Opener-Policy', coop)
  // A JSON API renders nothing and frames nothing, so lock it down by default.
  // Callers override with their own policy string, or pass `false` to omit it.
  const csp = options.contentSecurityPolicy ?? DEFAULT_CSP
  if (csp) reply.header('Content-Security-Policy', csp)
}

function applyCors(request: HttpRequest, reply: HttpReply, options: CorsOptions): void {
  const origin = resolveOrigin(options, headerOf(request, 'origin'))
  if (origin === null) return
  reply.header('Access-Control-Allow-Origin', origin)
  if (origin !== '*') reply.header('Vary', 'Origin')
  if (options.credentials) reply.header('Access-Control-Allow-Credentials', 'true')
  if (options.exposedHeaders?.length) reply.header('Access-Control-Expose-Headers', options.exposedHeaders.join(', '))
}

/**
 * Edge security — rate limiting, CORS and secure response headers — as a neutral
 * pre-hook, so it runs identically on Fastify, Express and Hono.
 */
export function securityPlugin(options: SecurityPluginOptions = {}) {
  const rateLimit = options.rateLimit
  const store = rateLimit ? (rateLimit.store ?? new MemoryRateLimitStore()) : undefined
  const cors = options.cors
  const headersOption = options.headers ?? true
  const headers: SecurityHeadersOptions | null =
    headersOption === false ? null : headersOption === true ? {} : headersOption

  // Per-route overrides, filled at app:booted from the `http:routes` metadata
  // bucket (adapters publish it). Populated before any request is served.
  const perRoute = new Map<string, RouteRateLimit>()

  return definePlugin({
    name: 'basalt:security',
    boot({ container, hooks }) {
      if (rateLimit && store) {
        hooks.on('app:booted', () => {
          const metadata = ensureMetadata(container)
          for (const route of metadata.get<{ url: string; meta?: Record<string, unknown> }>('http:routes')) {
            const override = parseRouteRateLimit(route.meta?.['rateLimit'])
            if (override) perRoute.set(route.url, override)
          }
        })
      }

      container.get(HTTP_SERVER).use(async ({ request, reply }) => {
        if (headers) applyHeaders(reply, headers)

        if (cors) {
          applyCors(request, reply, cors)
          if (request.method === 'OPTIONS' && headerOf(request, 'access-control-request-method')) {
            reply.header('Access-Control-Allow-Methods', (cors.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).join(', '))
            const requested = headerOf(request, 'access-control-request-headers')
            reply.header('Access-Control-Allow-Headers', cors.allowedHeaders?.join(', ') ?? requested ?? '*')
            reply.header('Access-Control-Max-Age', String(cors.maxAge ?? 600))
            reply.code(204).send()
            return
          }
        }

        if (rateLimit && store && !rateLimit.skip?.(request)) {
          const baseKey = rateLimit.key?.(request) ?? clientIp(request)
          // A route with its own `meta.rateLimit` gets a dedicated bucket (keyed
          // by client + route) at its stricter threshold; everything else shares
          // the global bucket, exactly as before.
          const override = request.routePattern ? perRoute.get(request.routePattern) : undefined
          const key = override ? `${baseKey}::${request.routePattern}` : baseKey
          const limit = override?.limit ?? rateLimit.limit
          const windowMs = override?.windowMs ?? rateLimit.windowMs
          const result = await store.hit(key, limit, windowMs)
          reply.header('X-RateLimit-Limit', String(result.limit))
          reply.header('X-RateLimit-Remaining', String(result.remaining))
          reply.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
          if (!result.allowed) {
            reply.header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
            reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests — slow down.' } })
          }
        }
      })
    },
  })
}
