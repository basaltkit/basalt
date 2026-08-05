import { definePlugin } from '@machize/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { FASTIFY } from './adapter.js'

// --- rate limiting ---------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Epoch ms when the current window resets. */
  resetAt: number
  /** ms until the caller may retry (0 when allowed). */
  retryAfterMs: number
}

/**
 * Backing store for the rate limiter. The default is in-memory (per process);
 * swap a Redis-backed store in for multi-instance deployments — same contract
 * as the cache/queue/mailer drivers.
 */
export interface RateLimitStore {
  hit(key: string, limit: number, windowMs: number): RateLimitResult
  reset(key: string): void
}

/** Fixed-window counter, in-memory. Lazily resets expired windows. */
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
  /** Max requests per window. */
  limit: number
  /** Window length in ms. */
  windowMs: number
  /** Store — default MemoryRateLimitStore(). */
  store?: RateLimitStore
  /** Bucket key. Default: client IP. */
  key?: (request: FastifyRequest) => string
  /** Skip limiting for a request (health checks, etc.). */
  skip?: (request: FastifyRequest) => boolean
}

// --- CORS ------------------------------------------------------------------

export interface CorsOptions {
  /** true = reflect request Origin; string/array = allow-list; function = predicate. Default: true. */
  origin?: boolean | string | string[] | ((origin: string | undefined) => boolean)
  methods?: string[]
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  credentials?: boolean
  /** Preflight cache seconds. */
  maxAge?: number
}

// --- security headers ------------------------------------------------------

export interface SecurityHeadersOptions {
  /** Strict-Transport-Security. Default on (maxAge 180d, includeSubDomains). */
  hsts?: boolean | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean }
  /** X-Content-Type-Options: nosniff. Default true. */
  contentTypeOptions?: boolean
  /** X-Frame-Options. Default 'DENY'. */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  /** Referrer-Policy. Default 'no-referrer'. */
  referrerPolicy?: string | false
  /** Content-Security-Policy. Default off (APIs); set for HTML surfaces. */
  contentSecurityPolicy?: string | false
  /** Cross-Origin-Opener-Policy. Default 'same-origin'. */
  crossOriginOpenerPolicy?: string | false
}

export interface SecurityPluginOptions {
  rateLimit?: RateLimitOptions | false
  cors?: CorsOptions | false
  /** true = secure defaults; object = customize; false = off. Default: true. */
  headers?: SecurityHeadersOptions | boolean
}

const header = (reply: FastifyReply, name: string, value: string): void => {
  void reply.header(name, value)
}

function resolveOrigin(option: CorsOptions['origin'], requestOrigin: string | undefined): string | null {
  if (option === undefined || option === true) return requestOrigin ?? '*'
  if (option === false) return null
  if (typeof option === 'string') return option
  if (Array.isArray(option)) return requestOrigin && option.includes(requestOrigin) ? requestOrigin : null
  return requestOrigin && option(requestOrigin) ? requestOrigin : null
}

function applyHeaders(reply: FastifyReply, options: SecurityHeadersOptions): void {
  const hsts = options.hsts ?? true
  if (hsts) {
    const config = hsts === true ? {} : hsts
    const maxAge = config.maxAge ?? 15_552_000
    let value = `max-age=${maxAge}`
    if (config.includeSubDomains ?? true) value += '; includeSubDomains'
    if (config.preload) value += '; preload'
    header(reply, 'Strict-Transport-Security', value)
  }
  if (options.contentTypeOptions ?? true) header(reply, 'X-Content-Type-Options', 'nosniff')
  const frame = options.frameOptions ?? 'DENY'
  if (frame) header(reply, 'X-Frame-Options', frame)
  const referrer = options.referrerPolicy ?? 'no-referrer'
  if (referrer) header(reply, 'Referrer-Policy', referrer)
  const coop = options.crossOriginOpenerPolicy ?? 'same-origin'
  if (coop) header(reply, 'Cross-Origin-Opener-Policy', coop)
  if (options.contentSecurityPolicy) header(reply, 'Content-Security-Policy', options.contentSecurityPolicy)
}

function applyCors(request: FastifyRequest, reply: FastifyReply, options: CorsOptions): void {
  const requestOrigin = request.headers.origin
  const origin = resolveOrigin(options.origin, requestOrigin)
  if (origin === null) return
  header(reply, 'Access-Control-Allow-Origin', origin)
  if (origin !== '*') header(reply, 'Vary', 'Origin')
  if (options.credentials) header(reply, 'Access-Control-Allow-Credentials', 'true')
  if (options.exposedHeaders?.length) {
    header(reply, 'Access-Control-Expose-Headers', options.exposedHeaders.join(', '))
  }
}

/**
 * Edge security for the HTTP adapter: rate limiting, CORS and secure response
 * headers — all secure-by-default and wired through native Fastify hooks.
 *
 * securityPlugin({
 *   rateLimit: { limit: 100, windowMs: 60_000 },
 *   cors: { origin: ['https://app.example.com'], credentials: true },
 *   headers: true,
 * })
 */
export function securityPlugin(options: SecurityPluginOptions = {}) {
  const rateLimit = options.rateLimit
  const store = rateLimit ? rateLimit.store ?? new MemoryRateLimitStore() : undefined
  const cors = options.cors
  const headersOption = options.headers ?? true
  const headers: SecurityHeadersOptions | null =
    headersOption === false ? null : headersOption === true ? {} : headersOption

  return definePlugin({
    name: 'machize:security',
    dependsOn: ['machize:fastify'],
    boot({ container }) {
      const app: FastifyInstance = container.get(FASTIFY)

      app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (headers) applyHeaders(reply, headers)

        if (cors) {
          applyCors(request, reply, cors)
          // CORS preflight: answer and stop before routing/rate-limit.
          if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
            header(reply, 'Access-Control-Allow-Methods', (cors.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).join(', '))
            const reqHeaders = request.headers['access-control-request-headers']
            header(reply, 'Access-Control-Allow-Headers', cors.allowedHeaders?.join(', ') ?? (typeof reqHeaders === 'string' ? reqHeaders : '*'))
            header(reply, 'Access-Control-Max-Age', String(cors.maxAge ?? 600))
            return reply.code(204).send()
          }
        }

        if (rateLimit && store && !rateLimit.skip?.(request)) {
          const key = rateLimit.key?.(request) ?? request.ip
          const result = store.hit(key, rateLimit.limit, rateLimit.windowMs)
          header(reply, 'X-RateLimit-Limit', String(result.limit))
          header(reply, 'X-RateLimit-Remaining', String(result.remaining))
          header(reply, 'X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
          if (!result.allowed) {
            header(reply, 'Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
            return reply.code(429).send({
              error: { code: 'RATE_LIMITED', message: 'Too many requests — slow down.' },
            })
          }
        }

        return undefined
      })
    },
  })
}
