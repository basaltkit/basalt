import type { BasaltRoute } from './route.js'

/**
 * The security-relevant route-meta keys the framework knows about. Each is
 * enforced by a guard that a specific plugin registers:
 *
 * - `auth` — `@basaltkit/auth`'s `authPlugin`
 * - `can` — `@basaltkit/permissions`' `permissionsPlugin`
 * - `teamRole` — `@basaltkit/teams`' `teamsPlugin`
 *
 * Declaring one of these on a route is a *request* for protection; the guard is
 * what enforces it. A route that declares a key nobody enforces would silently
 * serve unprotected — the adapters therefore call {@link assertRoutesGuarded}
 * at boot and fail loud instead.
 */
export const GUARDED_META_KEYS = ['auth', 'can', 'teamRole'] as const

/**
 * Metadata bucket where enforcing plugins claim the meta key(s) their guards
 * consume (e.g. authPlugin adds `'auth'`). String-keyed — no package coupling.
 */
export const GUARDED_META_BUCKET = 'http:guarded-meta'

/** Boot-time error: routes declare security meta that no registered guard enforces. */
export class UnguardedRouteMetaError extends Error {
  readonly code = 'HTTP_UNGUARDED_ROUTE_META'
  constructor(offenders: { route: string; key: string }[]) {
    const lines = offenders.map(({ route, key }) => `  - ${route} declares meta.${key}`).join('\n')
    super(
      `Refusing to boot: ${offenders.length} route(s) declare security meta that NO registered guard enforces — they would serve unprotected:\n${lines}\n` +
        `Register the enforcing plugin (auth → authPlugin, can → permissionsPlugin, teamRole → teamsPlugin), ` +
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
