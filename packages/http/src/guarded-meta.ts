import type { BasaltRoute } from './route.js'

/**
 * The security-relevant route-meta keys the framework knows about. Each is
 * enforced by a guard that a specific plugin registers:
 *
 * - `auth` — `@basaltkit/auth`'s `authPlugin`
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
export const GUARDED_META_KEYS = ['auth', 'can', 'teamRole', 'scopes', 'subscribed', 'feature'] as const

/** Which plugin enforces each guarded key — used to make the boot error actionable. */
const ENFORCED_BY: Record<string, string> = {
  auth: 'authPlugin',
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

/**
 * Fails loud (at boot) when a route declares one of {@link GUARDED_META_KEYS}
 * and no registered guard claimed that key via {@link GUARDED_META_BUCKET}.
 * `allow` waives the check: `true` for everything (edge-auth deployments),
 * or an array of specific keys. A value of `false`/`undefined` on the route's
 * meta is an explicit opt-off, not a protection request — never flagged.
 */
export function assertRoutesGuarded(
  routes: readonly BasaltRoute[],
  claimed: ReadonlySet<string>,
  allow?: boolean | readonly string[],
): void {
  if (allow === true) return
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
