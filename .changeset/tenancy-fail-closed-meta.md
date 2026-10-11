---
'@basaltkit/tenancy': major
---

An unknown `meta.tenant` fails closed at request time too.

The boot validator already refuses such a route on every adapter and in `mcpPlugin`. A route that skipped it (a custom driver calling `runRoute()` without `assertRouteMetaValid()`) used to fall back to the app-wide `required` default, so a typo of `'never'` served a central-only route on tenant hosts. Now:

- `isTenantRequired()` throws the new `InvalidTenantMetaError` (`TENANCY_INVALID_ROUTE_META`, 500) for a `meta.tenant` other than `true`, `false`, `'never'` or absent, instead of returning the default.
- `tenancyPlugin`'s enricher throws the same error before resolving a tenant, so the request never runs, with or without a tenant.
- `tenantMetaProblem(value)` is exported: the check the boot validator and the request-time check share.

This holds for a driver that passes the app's enrichers (`http:enrichers`) to `runRoute()`, as every adapter does; `@basaltkit/http` 3.0 refuses enrichers without a `container` (`HTTP_ENRICHERS_UNRUNNABLE`) instead of skipping them, so the enricher cannot be dropped in silence.

**Migrating.** Nothing to do for an app that boots: such routes are already refused at boot.
