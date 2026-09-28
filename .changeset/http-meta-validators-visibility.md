---
'@basaltkit/http': minor
'@basaltkit/fastify': minor
'@basaltkit/express': minor
'@basaltkit/hono': minor
---

Boot-time route-meta validation and side-effect-free route visibility (framework audit FA-044 / FA-035 residuals).

- **Route-meta validators.** Plugins can register a `RouteMetaValidator` in the new `META_VALIDATORS_BUCKET` (`'http:meta-validators'`) to check the *values* their meta keys carry. Every adapter (Fastify, Express, Hono — identically, covered by the shared parity suite) runs them over its full route list at boot, right after the guarded-meta check, and refuses to boot with the new `InvalidRouteMetaError` (`HTTP_INVALID_ROUTE_META`, listing every `route: problem`). A validator that throws counts as a problem. `allowUnguardedMeta` never waives them. `assertRoutesGuarded(routes, container)` now runs them too, and `assertRouteMetaValid(routes, container)` runs them alone — for code driving `runRoute()` without an adapter. Passing a plain `Set` of claimed keys keeps the old behaviour (no validators).
- **Route visibility.** New `ROUTE_VISIBILITY_BUCKET` (`'http:route-visibility'`) + `RouteVisibilityCheck` contract: a pure, side-effect-free companion of a guard ("could this caller possibly pass?") for surfaces that list routes. `isRouteVisible(route, context, container)` hides a `meta.auth` route from a caller without `context.user` (only when a guard claimed `auth`) and applies every registered check (a throwing check hides the route). Visibility is never authorization.
- The adapters now pass the container to `assertRoutesGuarded` instead of a `Set`.
