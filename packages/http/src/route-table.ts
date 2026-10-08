/**
 * A pure, framework-free view of an app's route table with the guards each
 * route declares (BK-025). Used by `basalt routes` and by route-security tests:
 *
 * ```ts
 * const app = await createApp({ plugins: [fastifyPlugin({ routes }), authPlugin(…)] }).boot()
 * const rows = describeRoutes(ensureMetadata(app.container).get('http:routes'))
 * expect(findUnguardedRoutes(rows, { require: ['auth', 'can'] })).toEqual([])
 * ```
 *
 * It reads route META only. What it cannot see, by construction:
 *
 * - routes registered by edge plugins through `HTTP_SERVER.addRoute()`
 *   (`healthPlugin`, `metricsPlugin`, `openapiPlugin`) — they are not in the
 *   `http:routes` bucket on any adapter;
 * - an app-wide rate limit (`securityPlugin({ rateLimit })`), URL-based tenancy
 *   (`tenancyPlugin({ required: { except } })`) and any app hook or middleware
 *   that protects a route without declaring it in `meta`.
 *
 * Importable without zod or any adapter: `@basaltkit/http/route-table`.
 */
import { GUARDED_META_KEYS } from './guarded-meta.js'

/** One entry of the `http:routes` metadata bucket, as every adapter writes it. */
export interface RouteTableEntry {
  method: string
  url: string
  meta?: Record<string, unknown> | undefined
  [key: string]: unknown
}

/** A route's declared guards, normalised for display, JSON and assertions. */
export interface RouteRow {
  method: string
  url: string
  /**
   * `meta.auth` as declared: `true` (session required), `false` (explicit
   * public opt-out), a string for a named strategy, `null` when undeclared.
   */
  auth: boolean | string | null
  /**
   * Permission names from `meta.can` (a resource requirement contributes its
   * `permission`). `[]` when the route explicitly declares `can: false`;
   * `null` when undeclared.
   */
  can: string[] | null
  /** `meta.rateLimit` as `'<limit>/<window>'` (plus `' per <key>'`), or `null`. */
  rateLimit: string | null
  /**
   * The route's tenancy declaration: `'required'` (`meta.tenant: true`),
   * `'exempt'` (`meta.tenant: false`), `'central'` (`meta.central: true`), or
   * `null` when the route leaves it to the app-wide default.
   */
  tenant: 'required' | 'exempt' | 'central' | null
  /** The route explicitly opts out of authentication (`meta.auth: false` or `meta.public: true`). */
  public: boolean
  /**
   * The other guarded keys the route declares (`mfa`, `teamRole`, `scopes`,
   * `subscribed`, `feature`), as `key` or `key=value`.
   */
  guards: string[]
}

/** What {@link findUnguardedRoutes} can require of every route. */
export type RouteRequirement = 'auth' | 'can'

export interface FindUnguardedOptions {
  /** Guards every route must declare. An explicit opt-out (`public`) satisfies both. */
  require: readonly RouteRequirement[]
  /** Routes exempt from the check (health probes, webhooks with their own signature…). */
  allow?: ((row: RouteRow) => boolean) | undefined
}

/** A route that misses one or more required guards. */
export interface UnguardedRoute {
  row: RouteRow
  missing: RouteRequirement[]
}

const ALREADY_SHOWN = new Set(['auth', 'can'])

/**
 * Normalises the `http:routes` bucket into {@link RouteRow}s, sorted by URL
 * then method so the output is stable across adapters and boot orders.
 * Pure: no container, no network, no adapter.
 */
export function describeRoutes(routes: readonly RouteTableEntry[]): RouteRow[] {
  return routes
    .map((route) => describeRoute(route))
    .sort((a, b) => (a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url)))
}

function describeRoute(route: RouteTableEntry): RouteRow {
  const meta = route.meta ?? {}
  const auth = authOf(meta['auth'])
  return {
    method: route.method.toUpperCase(),
    url: route.url,
    auth,
    can: canOf(meta['can']),
    rateLimit: rateLimitOf(meta['rateLimit']),
    tenant: tenantOf(meta),
    public: auth === false || meta['public'] === true,
    guards: GUARDED_META_KEYS.filter((key) => !ALREADY_SHOWN.has(key))
      .filter((key) => meta[key] !== undefined && meta[key] !== false)
      .map((key) => (meta[key] === true ? key : `${key}=${display(meta[key])}`)),
  }
}

function authOf(value: unknown): boolean | string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean' || typeof value === 'string') return value
  // Any other declared value is a protection request the guard interprets.
  return true
}

function canOf(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (value === false) return []
  const entries = Array.isArray(value) ? value : [value]
  return entries.map((entry) => {
    if (typeof entry === 'string') return entry
    if (entry && typeof entry === 'object' && typeof (entry as { permission?: unknown }).permission === 'string') {
      return (entry as { permission: string }).permission
    }
    return display(entry)
  })
}

function rateLimitOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const { limit, windowMs, key } = value as Record<string, unknown>
  if (typeof limit !== 'number' || typeof windowMs !== 'number') return null
  const per = typeof key === 'function' ? ' per custom key' : typeof key === 'string' && key !== 'ip' ? ` per ${key}` : ''
  return `${limit}/${formatWindow(windowMs)}${per}`
}

function formatWindow(ms: number): string {
  if (ms > 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms > 0 && ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}

function tenantOf(meta: Record<string, unknown>): RouteRow['tenant'] {
  if (meta['central'] === true) return 'central'
  if (meta['tenant'] === true) return 'required'
  if (meta['tenant'] === false) return 'exempt'
  return null
}

function display(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'function') return '<fn>'
  if (Array.isArray(value)) return value.map(display).join(',')
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '<object>'
    }
  }
  return String(value)
}

/**
 * Routes whose meta does not declare the guards in `require`. An explicit
 * opt-out is intentional and never reported: `auth: false` / `public: true`
 * satisfies both `auth` and `can`, and `can: false` satisfies `can`.
 *
 * This checks route META only — see the module comment for what it cannot see.
 */
export function findUnguardedRoutes(rows: readonly RouteRow[], options: FindUnguardedOptions): UnguardedRoute[] {
  const offenders: UnguardedRoute[] = []
  for (const row of rows) {
    if (row.public || options.allow?.(row)) continue
    const missing: RouteRequirement[] = []
    for (const requirement of options.require) {
      if (requirement === 'auth' && row.auth === null) missing.push('auth')
      if (requirement === 'can' && row.can === null) missing.push('can')
    }
    if (missing.length > 0) offenders.push({ row, missing })
  }
  return offenders
}
