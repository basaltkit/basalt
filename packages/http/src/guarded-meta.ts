import { ensureMetadata, type Container } from '@basaltkit/core'
import type { BasaltRoute } from './route.js'
import { routeHeadersProblems } from './route-headers.js'

/**
 * The security-relevant route-meta keys the framework knows about. Each is
 * enforced by a guard that a specific plugin registers:
 *
 * - `auth`, `mfa` — `@basaltkit/auth`'s `authPlugin`
 * - `can` — `@basaltkit/permissions`' `permissionsPlugin`
 * - `teamRole` — `@basaltkit/teams`' `teamsPlugin`
 * - `scopes` — `@basaltkit/auth`'s `apiKeysPlugin`
 * - `subscribed`, `feature` — `@basaltkit/subscriptions`' `subscriptionsPlugin`
 *
 * Declaring one of these on a route is a *request* for protection; the guard is
 * what enforces it. A route that declares a key nobody enforces would silently
 * serve unprotected — the adapters therefore call {@link assertRoutesGuarded}
 * at boot and fail loud instead.
 *
 * Deliberately NOT in this set: `central` (a tenant-membership *opt-out* — a
 * missing plugin removes a bypass, never a check), `mcp` (an exposure opt-in)
 * and `rateLimit` (abuse throttling, not an authorization boundary, and legal
 * to declare with `securityPlugin`'s optional rate limiter switched off).
 */
export const GUARDED_META_KEYS = ['auth', 'mfa', 'can', 'teamRole', 'scopes', 'subscribed', 'feature'] as const

/**
 * The rate-limit meta key. Not a guarded key (see above): declaring it with no
 * limiter does not refuse the boot. `securityPlugin({ rateLimit })` claims it in
 * {@link GUARDED_META_BUCKET}; when no plugin does, the adapters' boot check
 * WARNS (once per app) that those budgets are not enforced. Silence it with
 * `allowUnguardedMeta: ['rateLimit']` (or `true`) when an outer edge throttles.
 */
export const RATE_LIMIT_META_KEY = 'rateLimit'

/** Which plugin enforces each guarded key — used to make the boot error actionable. */
const ENFORCED_BY: Record<string, string> = {
  auth: 'authPlugin',
  mfa: 'authPlugin',
  can: 'permissionsPlugin',
  teamRole: 'teamsPlugin',
  scopes: 'apiKeysPlugin',
  subscribed: 'subscriptionsPlugin',
  feature: 'subscriptionsPlugin',
}

/**
 * Metadata bucket where enforcing plugins claim the meta key(s) their guards
 * consume (e.g. authPlugin adds `'auth'`). String-keyed — no package coupling.
 */
export const GUARDED_META_BUCKET = 'http:guarded-meta'

/** Boot-time error: routes declare security meta that no registered guard enforces. */
export class UnguardedRouteMetaError extends Error {
  readonly code = 'HTTP_UNGUARDED_ROUTE_META'
  constructor(offenders: { route: string; key: string }[]) {
    const lines = offenders
      .map(({ route, key }) => {
        const plugin = ENFORCED_BY[key]
        return `  - ${route} declares meta.${key}${plugin ? ` (enforced by ${plugin})` : ''}`
      })
      .join('\n')
    const needed = [...new Set(offenders.map(({ key }) => ENFORCED_BY[key]).filter(Boolean))]
    super(
      `Refusing to boot: ${offenders.length} route(s) declare security meta that NO registered guard enforces — they would serve unprotected:\n${lines}\n` +
        `Register the enforcing plugin${needed.length > 0 ? ` (${needed.join(', ')})` : ''}, ` +
        `or, if protection genuinely happens at an outer edge, opt out explicitly with the adapter option ` +
        `allowUnguardedMeta: true (or ['<key>', …]).`,
    )
    this.name = 'UnguardedRouteMetaError'
  }
}

const isContainer = (value: ReadonlySet<string> | Container): value is Container =>
  typeof (value as { createScope?: unknown }).createScope === 'function'

/**
 * Fails loud (at boot) when a route declares one of {@link GUARDED_META_KEYS}
 * and no registered guard claimed that key via {@link GUARDED_META_BUCKET}.
 * `allow` waives the check: `true` for everything (edge-auth deployments),
 * or an array of specific keys. A value of `false`/`undefined` on the route's
 * meta is an explicit opt-off, not a protection request — never flagged.
 *
 * Every adapter plugin calls this at boot. Code that drives `runRoute()`
 * itself — no adapter, e.g. a bespoke listener — gets no such check for free:
 * pass the booted app's container as `claimed` and the keys its plugins
 * claimed are read from it, the same check the adapters make:
 *
 * ```ts
 * const app = await createApp({ plugins: [authPlugin(…), permissionsPlugin(…)] }).boot()
 * assertRoutesGuarded(routes, app.container) // throws UnguardedRouteMetaError
 * ```
 *
 * Given a container, it also runs every route-meta validator plugins
 * registered in {@link META_VALIDATORS_BUCKET} (see
 * {@link assertRouteMetaValid}) — `allow` never waives those: a waiver says
 * "an outer edge enforces this key", not "a typo in its value is fine".
 */
export function assertRoutesGuarded(
  routes: readonly BasaltRoute[],
  claimed: ReadonlySet<string> | Container,
  allow?: boolean | readonly string[],
): void {
  // Duck-typed rather than `instanceof`: a second copy of @basaltkit/core in
  // node_modules would otherwise make a real container look like a set.
  const container = isContainer(claimed) ? claimed : undefined
  if (container) claimed = new Set(ensureMetadata(container).get<string>(GUARDED_META_BUCKET))
  if (allow !== true) assertClaimed(routes, claimed as ReadonlySet<string>, allow)
  if (container) {
    warnUnenforcedRateLimits(routes, container, claimed as ReadonlySet<string>, allow)
    assertRouteMetaValid(routes, container)
  }
}

/** Containers already warned about, so one app boot warns once. */
const rateLimitWarned = new WeakSet<object>()

/**
 * Warns (never throws) when routes declare `meta.rateLimit` and no plugin
 * claimed it — typically `securityPlugin` without its `rateLimit` option, so a
 * stricter login/export budget is silently not enforced. One warning per app;
 * waived by `allow === true` or an `allow` list that names `'rateLimit'`.
 */
function warnUnenforcedRateLimits(
  routes: readonly BasaltRoute[],
  container: Container,
  claimed: ReadonlySet<string>,
  allow: boolean | readonly string[] | undefined,
): void {
  if (allow === true || (Array.isArray(allow) && allow.includes(RATE_LIMIT_META_KEY))) return
  if (claimed.has(RATE_LIMIT_META_KEY) || rateLimitWarned.has(container)) return
  const offenders = routes
    .filter((route) => {
      const value = route.meta?.[RATE_LIMIT_META_KEY]
      return value !== undefined && value !== false && value !== null
    })
    .map((route) => `${route.method} ${route.url}`)
  if (offenders.length === 0) return
  rateLimitWarned.add(container)
  const shown = offenders.slice(0, 10).join(', ') + (offenders.length > 10 ? `, … (+${offenders.length - 10})` : '')
  console.warn(
    `[basalt] ${offenders.length} route(s) declare meta.rateLimit but no rate limiter is registered — ` +
      `those budgets are NOT enforced: ${shown}. Register securityPlugin({ rateLimit: { … } }), ` +
      `or pass the adapter option allowUnguardedMeta: ['rateLimit'] if an outer edge throttles.`,
  )
}

function assertClaimed(
  routes: readonly BasaltRoute[],
  claimed: ReadonlySet<string>,
  allow: false | readonly string[] | undefined,
): void {
  const waived = new Set(Array.isArray(allow) ? allow : [])
  const offenders: { route: string; key: string }[] = []
  for (const route of routes) {
    const meta = route.meta
    if (!meta) continue
    for (const key of GUARDED_META_KEYS) {
      const value = meta[key]
      if (value === undefined || value === false) continue
      if (claimed.has(key) || waived.has(key)) continue
      offenders.push({ route: `${route.method} ${route.url}`, key })
    }
  }
  if (offenders.length > 0) throw new UnguardedRouteMetaError(offenders)
}

/**
 * Metadata bucket where plugins register {@link RouteMetaValidator}s — boot-time
 * checks of the VALUES their route-meta keys carry (e.g. teamsPlugin refuses a
 * `meta.teamRole` naming no known role). String-keyed — no package coupling.
 */
export const META_VALIDATORS_BUCKET = 'http:meta-validators'

/**
 * A boot-time check of one route's meta, run by every adapter over its full
 * route list before it serves traffic. Return a problem description (or
 * several) to refuse the boot, nothing when the route is fine. Throwing counts
 * as a problem too (its message is reported). Must be synchronous and pure:
 * it runs once per route at boot, with the booted container.
 */
export type RouteMetaValidator = (input: {
  route: BasaltRoute
  container: Container
}) => string | readonly string[] | undefined | void

/** Boot-time error: a route-meta validator refused one or more routes. */
export class InvalidRouteMetaError extends Error {
  readonly code = 'HTTP_INVALID_ROUTE_META'
  readonly problems: readonly { route: string; problem: string }[]
  constructor(problems: { route: string; problem: string }[]) {
    const lines = problems.map(({ route, problem }) => `  - ${route}: ${problem}`).join('\n')
    super(`Refusing to boot: ${problems.length} route meta problem(s):\n${lines}`)
    this.name = 'InvalidRouteMetaError'
    this.problems = problems
  }
}

/**
 * Runs every {@link RouteMetaValidator} registered in
 * {@link META_VALIDATORS_BUCKET} over `routes` — plus the built-in check of
 * `meta.headers` — and throws one
 * {@link InvalidRouteMetaError} listing every problem found. The adapters run
 * it at boot (through {@link assertRoutesGuarded}); call it yourself when you
 * drive `runRoute()` without an adapter.
 */
export function assertRouteMetaValid(routes: readonly BasaltRoute[], container: Container): void {
  const validators = ensureMetadata(container).get<RouteMetaValidator>(META_VALIDATORS_BUCKET)
  const problems: { route: string; problem: string }[] = []
  for (const route of routes) {
    const name = `${route.method} ${route.url}`
    // Built in: `meta.headers` is read by the shared pipeline itself.
    for (const problem of routeHeadersProblems(route)) problems.push({ route: name, problem })
    for (const validate of validators) {
      let result: string | readonly string[] | undefined | void
      try {
        result = validate({ route, container })
      } catch (error) {
        result = error instanceof Error ? error.message : String(error)
      }
      if (result === undefined) continue
      for (const problem of typeof result === 'string' ? [result] : result) problems.push({ route: name, problem })
    }
  }
  if (problems.length > 0) throw new InvalidRouteMetaError(problems)
}
