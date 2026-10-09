---
'@basaltkit/tenancy': minor
---

Central-only routes: `meta: { tenant: 'never' }` (BK-043).

`tenant: false` lifts the tenant requirement but still resolves one, so a platform route reached on `acme.example.com/platform/…` ran inside Acme, against its storage, and a tenant owner holding `'*'` satisfied `can: 'platform:*'`. A route declared `tenant: 'never'` now refuses a resolved tenant in the tenancy enricher, which runs before every guard on all three adapters: the request gets the plain "route not found" body (`404 { error: { code: 'NOT_FOUND', message: 'Route not found.' } }`, new `CentralOnlyRouteError`), the tenant is not attached to the context and `tenancy:switched` is not emitted. On the apex the route runs normally.

`tenancyPlugin` also checks every route's `meta.tenant` at `app:booted` (from the `http:routes` table every adapter publishes): a value other than `true`, `false`, `'never'` or absent (a typo such as `'none'`, `'optional'`, `null`) logs one `[basalt] meta.tenant …` boot warning naming the routes, and keeps falling back to the app-wide `required` default, exactly as before. If you meant central-only, the value is `'never'`. The next major refuses the boot instead. Apps that only use `true`/`false` see nothing.
