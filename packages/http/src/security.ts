import { definePlugin, ensureMetadata, type RequestContext } from '@basaltkit/core'
import { HttpError } from './errors.js'
import {
  GUARDED_META_BUCKET,
  InvalidRouteMetaError,
  META_VALIDATORS_BUCKET,
  RATE_LIMIT_META_KEY,
  type RouteMetaValidator,
} from './guarded-meta.js'
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
   * Most open buckets kept at once (default 100 000). Past it, expired buckets
   * are swept and, if the store is still full, the oldest windows are evicted
   * first — so a flood of distinct client addresses (IPv6 makes them cheap)
   * costs bounded memory instead of growing the process until it dies.
   * Evicting a live window resets that client's count, so size it well above
   * your real distinct-client count per window; use `RedisRateLimitStore`
   * across instances.
   *
   * A bucket that has used up its limit is never evicted: it is held until its
   * window ends, so a flood of fresh keys cannot free a limited client early.
   * Those buckets are the only ones allowed past the cap — each cost its client
   * a full limit of requests, and each goes when its window does.
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
  // Buckets that reached their limit. Kept apart so eviction — which only ever
  // walks `windows` — can never reset a limited client, and stays O(1).
  private readonly exhausted = new Map<string, { count: number; resetAt: number }>()
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
    return this.windows.size + this.exhausted.size
  }

  hit(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.clock()
    if (now >= this.nextSweepAt) {
      this.sweep(now)
      this.nextSweepAt = now + this.sweepIntervalMs
    }
    let window = this.exhausted.get(key) ?? this.windows.get(key)
    if (!window || now >= window.resetAt) {
      if (window) {
        this.windows.delete(key)
        this.exhausted.delete(key)
      } else if (this.windows.size >= this.maxEntries) this.makeRoom(now)
      window = { count: 0, resetAt: now + windowMs }
      this.windows.set(key, window)
    }
    window.count += 1
    if (window.count >= limit && this.windows.delete(key)) this.exhausted.set(key, window)
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
    this.exhausted.delete(key)
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (now >= window.resetAt) this.windows.delete(key)
    for (const [key, window] of this.exhausted) if (now >= window.resetAt) this.exhausted.delete(key)
  }

  // Evicts from the FRONT only (oldest windows first), so admitting a new key
  // into a full store is amortised O(1). A full sweep here would rescan every
  // bucket for each new client once the store is full — a flood of distinct
  // addresses would turn the memory bound into a CPU denial of service.
  // Exhausted buckets live in their own map and are never candidates.
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
  /**
   * The id of the global (pre-routing) bucket. Default: the client IP.
   *
   * It runs BEFORE authentication, so it must never read an unverified
   * credential header (`x-api-key`, `Authorization`): a client that sends a
   * fresh made-up value on every request gets a fresh bucket every time and
   * is never limited. For per-key budgets use `meta.rateLimit` with
   * `key: 'apiKey'`, which reads the key the enricher verified.
   */
  key?: (request: HttpRequest) => string
  skip?: (request: HttpRequest) => boolean
  /**
   * Path-prefix budgets, charged before routing on every adapter. A request
   * whose path falls under a prefix is charged on that prefix's bucket
   * INSTEAD of the global one (the longest matching prefix wins), so a public
   * API under `/v1` can get a higher per-IP ceiling than the rest of the app —
   * while still paying a per-IP budget before any credential is looked up.
   *
   * Prefixes set or lift the edge budget for a path family. They are matched
   * on the raw path with minimal normalisation, so they are not a way to make
   * one endpoint stricter: a budget that must hold for a specific route
   * belongs in that route's `meta.rateLimit`, which is bound to the matched
   * route.
   */
  prefixes?: readonly PrefixRateLimit[]
}

/** A pre-routing budget for every path under `prefix` (see {@link RateLimitOptions.prefixes}). */
export interface PrefixRateLimit {
  /**
   * Starts with `/`; matched on segment boundaries (`/v1` matches `/v1` and
   * `/v1/orders`, never `/v10`), case-insensitively, after the query string
   * is cut off, runs of `/` are collapsed and a trailing `/` is dropped. No
   * percent-decoding and no dot-segment resolution.
   */
  prefix: string
  limit: number
  windowMs: number
  /**
   * The bucket id inside this prefix. Default: the global `key`, else the
   * client IP. Runs before authentication, like the global `key`: never derive
   * it from an unverified credential header.
   */
  key?: (request: HttpRequest) => string
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
 * - `'apiKey'` — `ctx().apiKey.id`: one budget per API key. Only a key the
 *   API-keys enricher verified ever becomes a bucket id, so made-up keys can
 *   not mint fresh buckets (they fall back like any missing id, below). A
 *   per-key budget multiplies with the number of keys a customer mints:
 *   use it for bursts, and put quotas on `'tenant'`.
 * - a function of `ctx()` returning the bucket id.
 *
 * Resolved after enrichers ran, so auth/tenancy have set `ctx()`. When the id
 * is missing (anonymous caller, no tenant resolved, the function returns
 * nothing) the bucket falls back to the client IP, never mixed with identified
 * callers' buckets (those are namespaced `user:`/`tenant:`/`apikey:`/`key:`).
 *
 * The IP itself can be missing too: when the adapter could not resolve
 * `request.ip` (Hono on a runtime without `getClientIp`, a hand-built
 * pipeline, an MCP tool called over stdio or through `McpServer.callTool`).
 * The per-route guard then keys the bucket by the caller's identity
 * (`user:<id>|tenant:<id>`, resolved from `ctx()` like `'user+tenant'`), so
 * authenticated callers keep separate budgets. Anonymous ip-less requests all
 * share ONE bucket, `unknown` — deliberately fail-closed, since the
 * alternative would be a bucket per spoofable header. Resolve the address in
 * the adapter to get per-client buckets back.
 */
export type RateLimitKey =
  | 'ip'
  | 'user'
  | 'tenant'
  | 'user+tenant'
  | 'apiKey'
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
  /**
   * Name of a bucket shared by every route that declares it — e.g. one daily
   * quota for a whole public API. Every declaration of a name must carry the
   * same `limit`, `windowMs` and key string (function keys are not compared);
   * the boot is refused otherwise. Grammar: `/^[A-Za-z0-9._:-]{1,64}$/`.
   */
  bucket?: string
}

/**
 * What `meta.rateLimit` accepts: one budget, or several that are all enforced
 * (charged in order; the first one that refuses answers 429 and the later ones
 * are not charged). Use it with `satisfies` to type a route's meta:
 * `rateLimit: [...] satisfies RouteRateLimits`.
 */
export type RouteRateLimits = RouteRateLimit | readonly RouteRateLimit[]

const RATE_LIMIT_KEYS = new Set(['ip', 'user', 'tenant', 'user+tenant', 'apiKey'])
const BUCKET_NAME = /^[A-Za-z0-9._:-]{1,64}$/

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
 * `apikey:`, `key:`) so an id can never collide with an IP bucket; `undefined` when the
 * key cannot be resolved and the caller falls back to the IP.
 */
function identityKey(key: RateLimitKey | undefined, context: RequestContext): string | undefined {
  if (key === undefined || key === 'ip') return undefined
  if (typeof key === 'function') {
    const id = key(context)
    return typeof id === 'string' && id !== '' ? `key:${id}` : undefined
  }
  if (key === 'apiKey') {
    const apiKey = idOf(context['apiKey'])
    return apiKey !== undefined ? `apikey:${apiKey}` : undefined
  }
  const user = idOf(context['user'])
  const tenant = idOf(context['tenant'])
  if (key === 'user') return user !== undefined ? `user:${user}` : undefined
  if (key === 'tenant') return tenant !== undefined ? `tenant:${tenant}` : undefined
  // 'user+tenant'
  if (user === undefined) return undefined
  return tenant !== undefined ? `user:${user}|tenant:${tenant}` : `user:${user}`
}

/**
 * One budget the route guard charges, with the scope part of its store key.
 * Only the new forms (an array, or an object with `bucket`) build plans; the
 * legacy single object keeps its historical key and code path.
 */
interface ChargePlan {
  limit: number
  windowMs: number
  key?: RateLimitKey
  /** `bucket:<name>` or `route:<METHOD> <url>#<index>`. */
  scope: string
}

/**
 * True for the forms charged through {@link ChargePlan}s: an array, or an
 * object carrying a STRING `bucket`. A legacy object with `bucket: null` (say
 * `cond ? 'name' : null`) or another non-string bucket keeps the legacy
 * lenient parse, enforced per route as before this release.
 */
const isMultiForm = (value: unknown): boolean =>
  Array.isArray(value) || (isObject(value) && typeof (value as { bucket?: unknown }).bucket === 'string')

/**
 * The plans for a route's `meta.rateLimit` in a new form, in declared order.
 * Malformed entries are skipped here; the boot-time validator refuses them
 * before any traffic, so they are never served.
 */
function chargePlansOf(value: unknown, method: string, url: string): ChargePlan[] {
  const entries: readonly unknown[] = Array.isArray(value) ? value : [value]
  const plans: ChargePlan[] = []
  entries.forEach((entry, index) => {
    const parsed = parseRouteRateLimit(entry)
    if (!parsed) return
    const bucket = (entry as { bucket?: unknown }).bucket
    const scope =
      typeof bucket === 'string' && BUCKET_NAME.test(bucket) ? `bucket:${bucket}` : `route:${method.toUpperCase()} ${url}#${index}`
    plans.push({ limit: parsed.limit, windowMs: parsed.windowMs, ...(parsed.key !== undefined ? { key: parsed.key } : {}), scope })
  })
  return plans
}

const isPositiveFinite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0

/** Shape problems of one entry of a new-form `meta.rateLimit` (`at` names it in messages). */
function entryProblems(entry: unknown, at: string): string[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [`${at} must be an object { limit, windowMs, key?, bucket? }`]
  const { limit, windowMs, key, bucket } = entry as Record<string, unknown>
  const problems: string[] = []
  if (!isPositiveFinite(limit)) problems.push(`${at}.limit must be a finite number above 0 (got ${String(limit)})`)
  if (!isPositiveFinite(windowMs)) problems.push(`${at}.windowMs must be a finite number above 0 (got ${String(windowMs)})`)
  if (key !== undefined && typeof key !== 'function' && !(typeof key === 'string' && RATE_LIMIT_KEYS.has(key))) {
    problems.push(`${at}.key ${JSON.stringify(key)} is not one of ${[...RATE_LIMIT_KEYS].map((k) => `'${k}'`).join(', ')} or a function`)
  }
  // `bucket: null` counts as absent (`[{ …, bucket: cond ? 'x' : null }]`).
  if (bucket != null && !(typeof bucket === 'string' && BUCKET_NAME.test(bucket))) {
    problems.push(`${at}.bucket ${JSON.stringify(bucket)} must match ${String(BUCKET_NAME)}`)
  }
  return problems
}

/**
 * Boot-time shape check of `meta.rateLimit` in its new forms (an array, or an
 * object with a string `bucket`). Stateless and per route, as a RouteMetaValidator
 * must be; whether the declarations of one shared bucket agree across routes
 * is checked at `app:booted`. The legacy single object stays lenient (a
 * malformed one gets no limit, an unknown key the IP bucket) so apps that boot
 * today still do.
 */
const rateLimitMetaValidator: RouteMetaValidator = ({ route }) => {
  const value = route.meta?.['rateLimit']
  if (!isMultiForm(value)) return undefined
  const problems = Array.isArray(value)
    ? value.length === 0
      ? ['meta.rateLimit must not be an empty array']
      : value.flatMap((entry, index) => entryProblems(entry, `meta.rateLimit[${index}]`))
    : entryProblems(value, 'meta.rateLimit')
  return problems.length > 0 ? problems : undefined
}

interface PublishedRoute {
  method?: string
  url: string
  meta?: Record<string, unknown>
}

interface BucketDeclaration {
  limit: number
  windowMs: number
  /** The key string (`'ip'` when omitted), or `null` for a function key. */
  key: string | null
  route: string
}

/**
 * Cross-route check of shared buckets: every declaration of one `bucket` name
 * must agree on `limit`, `windowMs` and key string. Function keys are never
 * compared — two inline lambdas are different objects but may mean the same,
 * and their ids are namespaced (`key:`) apart from every string key's anyway.
 */
function sharedBucketProblems(routes: readonly PublishedRoute[]): { route: string; problem: string }[] {
  const seen = new Map<string, BucketDeclaration>()
  const problems: { route: string; problem: string }[] = []
  for (const r of routes) {
    const value = r.meta?.['rateLimit']
    if (!isMultiForm(value)) continue
    const name = `${String(r.method ?? '').toUpperCase()} ${r.url}`
    for (const entry of Array.isArray(value) ? (value as readonly unknown[]) : [value]) {
      const bucket = isObject(entry) ? (entry as { bucket?: unknown }).bucket : undefined
      if (typeof bucket !== 'string') continue
      const parsed = parseRouteRateLimit(entry)
      if (!parsed) continue
      const key = typeof parsed.key === 'function' ? null : (parsed.key ?? 'ip')
      const first = seen.get(bucket)
      if (!first) {
        seen.set(bucket, { limit: parsed.limit, windowMs: parsed.windowMs, key, route: name })
        continue
      }
      const differences: string[] = []
      if (first.limit !== parsed.limit) differences.push(`limit ${parsed.limit} vs ${first.limit}`)
      if (first.windowMs !== parsed.windowMs) differences.push(`windowMs ${parsed.windowMs} vs ${first.windowMs}`)
      if (first.key !== null && key !== null && first.key !== key) differences.push(`key '${key}' vs '${first.key}'`)
      if (differences.length > 0) {
        problems.push({
          route: name,
          problem: `meta.rateLimit bucket '${bucket}' disagrees with its first declaration (${first.route}): ${differences.join(', ')}`,
        })
      }
    }
  }
  return problems
}

/**
 * Normalises a path for prefix matching: cut at `?`/`#`, collapse runs of `/`,
 * lowercase, drop a trailing `/`. Deliberately no percent-decoding and no
 * dot-segment resolution: prefixes set or lift a budget, they do not harden one.
 */
function normalisePath(url: string): string {
  let end = url.length
  const query = url.indexOf('?')
  if (query !== -1) end = query
  const hash = url.indexOf('#')
  if (hash !== -1 && hash < end) end = hash
  let path = url.slice(0, end).replace(/\/{2,}/g, '/').toLowerCase()
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

interface PrefixRule extends PrefixRateLimit {
  /** The normalised prefix (also the bucket namespace). */
  normalised: string
}

/** Validates and normalises `rateLimit.prefixes`, longest first. Throws `TypeError` on a bad rule. */
function compilePrefixes(prefixes: readonly PrefixRateLimit[] | undefined): PrefixRule[] {
  if (prefixes === undefined) return []
  if (!Array.isArray(prefixes)) throw new TypeError('securityPlugin: rateLimit.prefixes must be an array')
  const rules: PrefixRule[] = []
  const seen = new Set<string>()
  for (const rule of prefixes as readonly PrefixRateLimit[]) {
    const where = `securityPlugin: rateLimit.prefixes entry ${JSON.stringify(rule?.prefix)}`
    if (typeof rule?.prefix !== 'string' || !rule.prefix.startsWith('/')) {
      throw new TypeError(`${where}: prefix must be a string starting with '/'`)
    }
    if (rule.prefix.includes('?') || rule.prefix.includes('#')) throw new TypeError(`${where}: prefix must not contain '?' or '#'`)
    if (!isPositiveFinite(rule.limit) || !isPositiveFinite(rule.windowMs)) {
      throw new TypeError(`${where}: limit and windowMs must be finite numbers above 0`)
    }
    if (rule.key !== undefined && typeof rule.key !== 'function') throw new TypeError(`${where}: key must be a function of the request`)
    const normalised = normalisePath(rule.prefix)
    if (seen.has(normalised)) throw new TypeError(`${where}: duplicates another prefix (both normalise to '${normalised}')`)
    seen.add(normalised)
    rules.push({ ...rule, normalised })
  }
  return rules.sort((a, b) => b.normalised.length - a.normalised.length)
}

const prefixMatches = (path: string, prefix: string): boolean =>
  prefix === '/' || path === prefix || path.startsWith(`${prefix}/`)

/**
 * Which result's `X-RateLimit-*` headers a multi-budget route reports: the
 * one with the fewest requests left; on a tie, the one that resets later.
 */
const mostConstraining = (results: readonly RateLimitResult[]): RateLimitResult =>
  results.reduce((best, next) =>
    next.remaining < best.remaining || (next.remaining === best.remaining && next.resetAt > best.resetAt) ? next : best,
  )

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

/** Sets the CORS response headers; returns whether the request's origin is allowed. */
function applyCors(request: HttpRequest, reply: HttpReply, options: CorsOptions): boolean {
  const origin = resolveOrigin(options, headerOf(request, 'origin'))
  if (origin === null) return false
  reply.header('Access-Control-Allow-Origin', origin)
  if (origin !== '*') reply.header('Vary', 'Origin')
  if (options.credentials) reply.header('Access-Control-Allow-Credentials', 'true')
  if (options.exposedHeaders?.length) reply.header('Access-Control-Expose-Headers', options.exposedHeaders.join(', '))
  return true
}

/**
 * Answers a CORS preflight. The `Allow-*` headers go only to an allowed
 * origin: for any other the preflight is still answered (204, so the browser
 * reports a CORS failure rather than an HTTP one) but discloses nothing — not
 * the methods the API takes, and not the request headers echoed back.
 */
function answerPreflight(request: HttpRequest, reply: HttpReply, options: CorsOptions, allowed: boolean): void {
  if (allowed) {
    reply.header('Access-Control-Allow-Methods', (options.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).join(', '))
    const requested = headerOf(request, 'access-control-request-headers')
    reply.header('Access-Control-Allow-Headers', options.allowedHeaders?.join(', ') ?? requested ?? '*')
    reply.header('Access-Control-Max-Age', String(options.maxAge ?? 600))
  }
  reply.code(204).send()
}

/**
 * Edge security — rate limiting, CORS and secure response headers — as a neutral
 * pre-hook, so it runs identically on Fastify, Express and Hono.
 */
export function securityPlugin(options: SecurityPluginOptions = {}) {
  const rateLimit = options.rateLimit
  const store = rateLimit ? (rateLimit.store ?? new MemoryRateLimitStore()) : undefined
  // Validated now, at construction: a bad prefix is a configuration error.
  const prefixRules = rateLimit ? compilePrefixes(rateLimit.prefixes) : []
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
      // No IP (and no custom global key): an identified caller still gets
      // its own bucket; only anonymous ip-less callers share `unknown`.
      const identityOf = (key: RateLimitKey | undefined, request: HttpRequest, context: RequestContext): string =>
        identityKey(key, context) ?? rateLimit.key?.(request) ?? request.ip ?? identityKey('user+tenant', context) ?? 'unknown'

      const guard: RouteGuard = async ({ route, request, reply, context }) => {
        const value = route.meta?.['rateLimit']
        if (value === undefined || rateLimit.skip?.(request)) return

        // Several budgets and shared buckets: always charged here, on every
        // adapter, on top of the edge bucket. In declared order, stopping at
        // the first refusal so a burst refusal does not eat a daily quota.
        // Sequential hits: there is no atomicity across buckets.
        if (isMultiForm(value)) {
          const results: RateLimitResult[] = []
          for (const plan of chargePlansOf(value, route.method, route.url)) {
            const result = await store.hit(`rl|${plan.scope}|${identityOf(plan.key, request, context)}`, plan.limit, plan.windowMs)
            if (!result.allowed) {
              if (reply) applyRateLimitHeaders(reply, result)
              throw new HttpError(429, RATE_LIMITED.code, RATE_LIMITED.message)
            }
            results.push(result)
          }
          if (reply && results.length > 0) applyRateLimitHeaders(reply, mostConstraining(results))
          return
        }

        // The legacy single object: historical key and behaviour, unchanged.
        const override = parseRouteRateLimit(value)
        if (!override) return
        if (isObject(request.raw) && charged.has(request.raw)) return
        const result = await store.hit(`${identityOf(override.key, request, context)}::${route.url}`, override.limit, override.windowMs)
        if (reply) applyRateLimitHeaders(reply, result)
        if (!result.allowed) throw new HttpError(429, RATE_LIMITED.code, RATE_LIMITED.message)
      }
      const metadata = ensureMetadata(container)
      metadata.add('http:guards', guard)
      metadata.add(META_VALIDATORS_BUCKET, rateLimitMetaValidator)
      // Claim `meta.rateLimit` so the adapters' boot check knows the budgets
      // declared on routes are enforced (it warns when nobody claims them).
      metadata.add(GUARDED_META_BUCKET, RATE_LIMIT_META_KEY)
    },
    boot({ container, hooks }) {
      if (rateLimit && store) {
        hooks.on('app:booted', () => {
          const routes = ensureMetadata(container).get<PublishedRoute>('http:routes')
          for (const route of routes) {
            const value = route.meta?.['rateLimit']
            // Only the legacy single object feeds the Fastify fast path; the
            // new forms are always charged in the guard.
            if (isMultiForm(value)) continue
            const override = parseRouteRateLimit(value)
            if (override && typeof route.method === 'string') perRoute.set(routeKey(route.method, route.url), override)
          }
          // Shared buckets must agree across routes. Throwing here refuses
          // the boot on every adapter (app.boot awaits app:booted).
          const conflicts = sharedBucketProblems(routes)
          if (conflicts.length > 0) throw new InvalidRouteMetaError(conflicts)
        })
      }

      container.get(HTTP_SERVER).use(async ({ request, reply }) => {
        if (headers) applyHeaders(reply, headers)

        const originAllowed = cors ? applyCors(request, reply, cors) : false
        // A preflight is answered here, never routed — but only AFTER the rate
        // limiter: it used to short-circuit first, so preflights were free and
        // uncounted however many a client sent.
        const preflight =
          cors !== undefined && request.method === 'OPTIONS' && Boolean(headerOf(request, 'access-control-request-method'))

        if (rateLimit && store && !rateLimit.skip?.(request)) {
          // A route with its own `meta.rateLimit` gets a dedicated bucket. When
          // the adapter already knows the route here (Fastify), charge it now
          // (instead of the global bucket) and let the guard skip it; when it
          // does not (Express, Hono), the request counts against the global
          // bucket and the guard charges the dedicated, stricter one.
          // A user/tenant-keyed route cannot be charged here (no ctx() yet):
          // it counts against the global bucket and the guard charges its own.
          // A preflight always counts against the global bucket.
          const override =
            !preflight && request.routePattern ? perRoute.get(routeKey(request.method, request.routePattern)) : undefined
          if (override && request.routePattern && !needsContext(override)) {
            const result = await store.hit(`${clientKey(request)}::${request.routePattern}`, override.limit, override.windowMs)
            if (isObject(request.raw)) charged.add(request.raw)
            applyRateLimitHeaders(reply, result)
            if (!result.allowed) reply.code(429).send({ error: { ...RATE_LIMITED } })
            return
          }
          // A path-prefix budget replaces the global bucket for its family of
          // paths. It reads only `request.url`/`request.ip`, which every
          // adapter sets the same way, so it is identical on all three — and
          // it charges 404s, preflights and requests an enricher later
          // rejects, like the global bucket does.
          let rule: PrefixRule | undefined
          if (prefixRules.length > 0) {
            const path = normalisePath(request.url)
            rule = prefixRules.find((candidate) => prefixMatches(path, candidate.normalised))
          }
          const result = rule
            ? await store.hit(`prefix:${rule.normalised}::${rule.key?.(request) ?? clientKey(request)}`, rule.limit, rule.windowMs)
            : await store.hit(clientKey(request), rateLimit.limit, rateLimit.windowMs)
          applyRateLimitHeaders(reply, result)
          if (!result.allowed) {
            reply.code(429).send({ error: { ...RATE_LIMITED } })
            return
          }
        }

        if (preflight && cors) answerPreflight(request, reply, cors, originAllowed)
      })
    },
  })
}
