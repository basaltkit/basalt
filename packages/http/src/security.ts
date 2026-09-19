import { definePlugin, ensureMetadata, type RequestContext } from '@basaltkit/core'
import { HttpError } from './errors.js'
import type { RouteGuard } from './pipeline.js'
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

export interface MemoryRateLimitStoreOptions {
  clock?: () => number
  /**
   * Most buckets kept at once (default 100 000). Past it, expired buckets are
   * swept and, if the store is still full, the oldest windows are evicted first
   * — so a flood of distinct client addresses (IPv6 makes them cheap) costs
   * bounded memory instead of growing the process until it dies. Evicting a
   * live window resets that client's count, so size it well above your real
   * distinct-client count per window; use `RedisRateLimitStore` across
   * instances.
   */
  maxEntries?: number
  /** How often, at most, a hit sweeps every expired bucket (default 60 000 ms). */
  sweepIntervalMs?: number
}

/** Default cap on in-memory rate-limit buckets. */
export const DEFAULT_RATE_LIMIT_MAX_ENTRIES = 100_000

export class MemoryRateLimitStore implements RateLimitStore {
  // Insertion order == window start order (a new window re-inserts its key),
  // which makes the first entry the oldest window: FIFO eviction for free.
  private readonly windows = new Map<string, { count: number; resetAt: number }>()
  private readonly clock: () => number
  private readonly maxEntries: number
  private readonly sweepIntervalMs: number
  private nextSweepAt = 0

  constructor(clockOrOptions: (() => number) | MemoryRateLimitStoreOptions = {}) {
    const options = typeof clockOrOptions === 'function' ? { clock: clockOrOptions } : clockOrOptions
    this.clock = options.clock ?? (() => Date.now())
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_RATE_LIMIT_MAX_ENTRIES))
    this.sweepIntervalMs = Math.max(0, options.sweepIntervalMs ?? 60_000)
  }

  /** Buckets currently held (live or not yet swept). */
  get size(): number {
    return this.windows.size
  }

  hit(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.clock()
    if (now >= this.nextSweepAt) {
      this.sweep(now)
      this.nextSweepAt = now + this.sweepIntervalMs
    }
    let window = this.windows.get(key)
    if (!window || now >= window.resetAt) {
      if (window) this.windows.delete(key)
      else if (this.windows.size >= this.maxEntries) this.makeRoom(now)
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

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (now >= window.resetAt) this.windows.delete(key)
  }

  // Evicts from the FRONT only (oldest windows first), so admitting a new key
  // into a full store is amortised O(1). A full sweep here would rescan every
  // bucket for each new client once the store is full — a flood of distinct
  // addresses would turn the memory bound into a CPU denial of service.
  private makeRoom(now: number): void {
    for (const [key, window] of this.windows) {
      if (this.windows.size < this.maxEntries && now < window.resetAt) break
      this.windows.delete(key)
    }
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
  /**
   * Cache-Control value. Defaults to `no-store`: API responses carry session
   * tokens, API keys and MFA secrets that no browser or intermediary cache may
   * keep. A route that is safe to cache sets its own header (it replaces this
   * one); pass a string to change the default, or `false` to omit it.
   */
  cacheControl?: string | false
}

/** Default Cache-Control for API responses. */
export const DEFAULT_CACHE_CONTROL = 'no-store'

/** Restrictive default CSP for a JSON API: it renders nothing and frames nothing. */
export const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'"

/**
 * Who a per-route bucket belongs to (`meta.rateLimit.key`):
 *
 * - `'ip'` (default) — the client address (`request.ip`), as before.
 * - `'user'` — `ctx().user.id`: users behind one NAT/proxy no longer share a budget.
 * - `'tenant'` — `ctx().tenant.id`: every user of a tenant shares one budget.
 * - `'user+tenant'` — one budget per user per tenant.
 * - a function of `ctx()` returning the bucket id.
 *
 * Resolved after enrichers ran, so auth/tenancy have set `ctx()`. When the id
 * is missing (anonymous caller, no tenant resolved, the function returns
 * nothing) the bucket falls back to the client IP — never to one shared
 * bucket, and never mixed with identified callers' buckets.
 */
export type RateLimitKey =
  | 'ip'
  | 'user'
  | 'tenant'
  | 'user+tenant'
  | ((context: RequestContext) => string | undefined | null)

/**
 * Per-route rate-limit override, read from a route's `meta.rateLimit`. When set,
 * that route gets its own bucket (keyed by `key` + route) at these thresholds
 * instead of the global default — so login/reset can be stricter than the rest.
 */
export interface RouteRateLimit {
  limit: number
  windowMs: number
  /** Who the bucket belongs to. Default `'ip'`. See {@link RateLimitKey}. */
  key?: RateLimitKey
}

const RATE_LIMIT_KEYS = new Set(['ip', 'user', 'tenant', 'user+tenant'])

/** Coerces a route's `meta.rateLimit` into a {@link RouteRateLimit}, or `null` if absent/malformed. */
function parseRouteRateLimit(value: unknown): RouteRateLimit | null {
  if (!value || typeof value !== 'object') return null
  const { limit, windowMs, key } = value as Record<string, unknown>
  if (typeof limit !== 'number' || typeof windowMs !== 'number') return null
  if (!(limit > 0) || !(windowMs > 0)) return null
  // An unrecognised key keeps the per-IP bucket: still limited, never unlimited.
  if (typeof key === 'function') return { limit, windowMs, key: key as RateLimitKey }
  if (typeof key === 'string' && RATE_LIMIT_KEYS.has(key)) return { limit, windowMs, key: key as RateLimitKey }
  return { limit, windowMs }
}

/** True when the bucket id can only be known after enrichers ran (not the IP). */
const needsContext = (override: RouteRateLimit): boolean => override.key !== undefined && override.key !== 'ip'

const idOf = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

/**
 * The identity part of a per-route bucket, namespaced (`user:`, `tenant:`,
 * `key:`) so an id can never collide with an IP bucket; `undefined` when the
 * key cannot be resolved and the caller falls back to the IP.
 */
function identityKey(key: RateLimitKey | undefined, context: RequestContext): string | undefined {
  if (key === undefined || key === 'ip') return undefined
  if (typeof key === 'function') {
    const id = key(context)
    return typeof id === 'string' && id !== '' ? `key:${id}` : undefined
  }
  const user = idOf(context['user'])
  const tenant = idOf(context['tenant'])
  if (key === 'user') return user !== undefined ? `user:${user}` : undefined
  if (key === 'tenant') return tenant !== undefined ? `tenant:${tenant}` : undefined
  // 'user+tenant'
  if (user === undefined) return undefined
  return tenant !== undefined ? `user:${user}|tenant:${tenant}` : `user:${user}`
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

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

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
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL
  if (cacheControl) reply.header('Cache-Control', cacheControl)
}

function applyRateLimitHeaders(reply: HttpReply, result: RateLimitResult): void {
  reply.header('X-RateLimit-Limit', String(result.limit))
  reply.header('X-RateLimit-Remaining', String(result.remaining))
  reply.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
  if (!result.allowed) reply.header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
}

const RATE_LIMITED = { code: 'RATE_LIMITED', message: 'Too many requests — slow down.' } as const

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

  // Per-route overrides by `METHOD url`, filled at app:booted from the
  // `http:routes` metadata bucket (adapters publish it). Keyed by method too: a
  // GET on a url whose POST is budgeted must still count against the global
  // limit. When the pre-hook knows the route (Fastify), it charges the dedicated
  // bucket itself — BEFORE enrichers run, so requests an enricher rejects are
  // counted too — and marks the native request so the guard does not charge it
  // a second time.
  const perRoute = new Map<string, RouteRateLimit>()
  const charged = new WeakSet<object>()
  const routeKey = (method: string, url: string): string => `${method.toUpperCase()} ${url}`
  const clientKey = (request: HttpRequest): string => rateLimit ? (rateLimit.key?.(request) ?? clientIp(request)) : clientIp(request)

  return definePlugin({
    name: 'basalt:security',
    register({ container }) {
      if (!rateLimit || !store) return
      // Per-route `meta.rateLimit` is enforced HERE, in a route guard, because a
      // guard always sees the matched route definition. The pre-hook cannot: on
      // Express and Hono it runs before routing, with no `routePattern`, and a
      // stricter login/reset budget used to be silently ignored there. Guards
      // also run when a route is invoked as an MCP tool, so the budget cannot be
      // sidestepped through `/mcp` either.
      // A `key` other than the IP (user/tenant) is resolved here, from ctx(),
      // because only after the enrichers ran are the user and tenant known.
      const guard: RouteGuard = async ({ route, request, reply, context }) => {
        const override = parseRouteRateLimit(route.meta?.['rateLimit'])
        if (!override || rateLimit.skip?.(request)) return
        if (isObject(request.raw) && charged.has(request.raw)) return
        const bucket = identityKey(override.key, context) ?? clientKey(request)
        const result = await store.hit(`${bucket}::${route.url}`, override.limit, override.windowMs)
        if (reply) applyRateLimitHeaders(reply, result)
        if (!result.allowed) throw new HttpError(429, RATE_LIMITED.code, RATE_LIMITED.message)
      }
      ensureMetadata(container).add('http:guards', guard)
    },
    boot({ container, hooks }) {
      if (rateLimit && store) {
        hooks.on('app:booted', () => {
          const metadata = ensureMetadata(container)
          for (const route of metadata.get<{ method?: string; url: string; meta?: Record<string, unknown> }>('http:routes')) {
            const override = parseRouteRateLimit(route.meta?.['rateLimit'])
            if (override && typeof route.method === 'string') perRoute.set(routeKey(route.method, route.url), override)
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
          // A route with its own `meta.rateLimit` gets a dedicated bucket. When
          // the adapter already knows the route here (Fastify), charge it now
          // (instead of the global bucket) and let the guard skip it; when it
          // does not (Express, Hono), the request counts against the global
          // bucket and the guard charges the dedicated, stricter one.
          // A user/tenant-keyed route cannot be charged here (no ctx() yet):
          // it counts against the global bucket and the guard charges its own.
          const override = request.routePattern ? perRoute.get(routeKey(request.method, request.routePattern)) : undefined
          if (override && request.routePattern && !needsContext(override)) {
            const result = await store.hit(`${clientKey(request)}::${request.routePattern}`, override.limit, override.windowMs)
            if (isObject(request.raw)) charged.add(request.raw)
            applyRateLimitHeaders(reply, result)
            if (!result.allowed) reply.code(429).send({ error: { ...RATE_LIMITED } })
            return
          }
          const result = await store.hit(clientKey(request), rateLimit.limit, rateLimit.windowMs)
          applyRateLimitHeaders(reply, result)
          if (!result.allowed) reply.code(429).send({ error: { ...RATE_LIMITED } })
        }
      })
    },
  })
}
