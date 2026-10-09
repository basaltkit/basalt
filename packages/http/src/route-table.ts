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
   * `meta.auth` as declared: `true` (session required — the only value
   * `authPlugin` enforces), `false` (explicit public opt-out), `null` when
   * undeclared. Any other value is shown as a string; it is NOT enforced, so
   * {@link findUnguardedRoutes} does not count it as `auth`.
   */
  auth: boolean | string | null
  /**
   * Permission names from `meta.can` (a resource requirement contributes its
   * `permission`). `[]` when the route explicitly declares `can: false`;
   * `null` when undeclared.
   */
  can: string[] | null
  /**
   * `meta.rateLimit` as `'<limit>/<window>'` (plus `' per <key>'` and, for a
   * shared bucket, `' [<name>]'`); several budgets are joined by `', '`. `null` when absent.
   */
  rateLimit: string | null
  /**
   * The route's tenancy declaration, read from `meta.tenant` only:
   * `'required'` (`true`), `'exempt'` (`false`), `'central-only'` (`'never'`
   * — the central plane only: a request that resolves a tenant is rejected),
   * or `null` when the route leaves it to the app-wide default (or declares a
   * value tenancy does not know). `meta.central` is not a tenancy declaration
   * (it is the `@basaltkit/teams` membership bypass) and is listed in
   * {@link RouteRow.guards} instead.
   *
   * New values may be added in a minor release: switch over it with a
   * `default` branch.
   */
  tenant: 'required' | 'exempt' | 'central-only' | null
  /** The route explicitly opts out of authentication (`meta.auth: false` or `meta.public: true`). */
  public: boolean
  /**
   * The other guarded keys the route declares (`mfa`, `teamRole`, `scopes`,
   * `subscribed`, `feature`), as `key` or `key=value`, plus `central` for
   * `meta.central: true` (the `@basaltkit/teams` membership bypass).
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
    guards: [
      ...GUARDED_META_KEYS.filter((key) => !ALREADY_SHOWN.has(key))
        .filter((key) => meta[key] !== undefined && meta[key] !== false)
        .map((key) => (meta[key] === true ? key : `${key}=${display(meta[key])}`)),
      ...(meta['central'] === true ? ['central'] : []),
    ],
  }
}

function authOf(value: unknown): boolean | string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value
  // `authPlugin` enforces `auth: true` only: anything else is displayed as
  // declared, never normalised to `true` (that would claim a protection the
  // guard does not apply).
  return display(value)
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
  if (Array.isArray(value)) {
    const entries = value.map(rateLimitEntryOf).filter((entry): entry is string => entry !== null)
    return entries.length > 0 ? entries.join(', ') : null
  }
  return rateLimitEntryOf(value)
}

/** One budget as `'<limit>/<window>'`, plus `' per <key>'` and `' [<shared bucket>]'`. */
function rateLimitEntryOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const { limit, windowMs, key, bucket } = value as Record<string, unknown>
  if (typeof limit !== 'number' || typeof windowMs !== 'number') return null
  const per = typeof key === 'function' ? ' per custom key' : typeof key === 'string' && key !== 'ip' ? ` per ${key}` : ''
  const shared = typeof bucket === 'string' ? ` [${bucket}]` : ''
  return `${limit}/${formatWindow(windowMs)}${per}${shared}`
}

function formatWindow(ms: number): string {
  if (ms > 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms > 0 && ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}

function tenantOf(meta: Record<string, unknown>): RouteRow['tenant'] {
  if (meta['tenant'] === 'never') return 'central-only'
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
 * satisfies both `auth` and `can`, and `can: false` satisfies `can`. Only
 * `auth: true` satisfies `auth` — the one value `authPlugin` enforces.
 *
 * This checks route META only — see the module comment for what it cannot see.
 */
export function findUnguardedRoutes(rows: readonly RouteRow[], options: FindUnguardedOptions): UnguardedRoute[] {
  const offenders: UnguardedRoute[] = []
  for (const row of rows) {
    if (row.public || options.allow?.(row)) continue
    const missing: RouteRequirement[] = []
    for (const requirement of options.require) {
      if (requirement === 'auth' && row.auth !== true) missing.push('auth')
      if (requirement === 'can' && row.can === null) missing.push('can')
    }
    if (missing.length > 0) offenders.push({ row, missing })
  }
  return offenders
}
