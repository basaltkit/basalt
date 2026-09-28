import { ensureMetadata, type Container } from '@basaltkit/core'
import { GUARDED_META_BUCKET } from './guarded-meta.js'
import type { BasaltRoute } from './route.js'

/**
 * Metadata bucket where plugins register {@link RouteVisibilityCheck}s — the
 * side-effect-free companion of their route guards, used by surfaces that
 * LIST routes to a caller (e.g. `@basaltkit/mcp`'s `tools/list`) to hide the
 * ones the caller statically cannot pass. String-keyed — no package coupling.
 */
export const ROUTE_VISIBILITY_BUCKET = 'http:route-visibility'

/**
 * Answers "could this caller possibly pass my guard on this route?" without
 * enforcing anything. Return `false` to hide the route; `true` or `undefined`
 * means "no objection" (including routes the check does not care about).
 *
 * The contract is what makes it safe to run on every listing, unlike a guard:
 * a check MUST be free of side effects — no rate-limit consumption, no audit
 * or denial records, no hooks, no writes. Plain reads (a membership lookup)
 * are fine. Visibility is never authorization: the route's guards still run
 * on every actual call, so a check that says "visible" too eagerly only
 * reveals a name, never grants access.
 */
export type RouteVisibilityCheck = (input: {
  route: BasaltRoute
  /** The caller's request context (`ctx()` of the listing request): `user`, `tenant`, … */
  context: Record<string, unknown>
  container: Container
}) => boolean | undefined | void | Promise<boolean | undefined | void>

/**
 * True unless the caller statically cannot pass this route's guards, judged
 * only by pure checks:
 *
 * - built in: a route declaring `meta.auth` is hidden from a caller with no
 *   `context.user` — but only when a registered guard claimed `auth` (under an
 *   edge-auth waiver no user ever appears in the context, and hiding every
 *   route would be wrong);
 * - every {@link RouteVisibilityCheck} registered in
 *   {@link ROUTE_VISIBILITY_BUCKET} (e.g. teamsPlugin's `meta.teamRole` check).
 *   A check that throws hides the route (fail closed).
 *
 * Keys no plugin registered a check for are NOT filtered — the route stays
 * visible and its guards decide on the call.
 */
export async function isRouteVisible(
  route: BasaltRoute,
  context: Record<string, unknown>,
  container: Container,
): Promise<boolean> {
  const metadata = ensureMetadata(container)
  const auth = route.meta?.['auth']
  if (auth !== undefined && auth !== false && !context['user']) {
    if (metadata.get<string>(GUARDED_META_BUCKET).includes('auth')) return false
  }
  for (const check of metadata.get<RouteVisibilityCheck>(ROUTE_VISIBILITY_BUCKET)) {
    try {
      if ((await check({ route, context, container })) === false) return false
    } catch {
      return false
    }
  }
  return true
}
