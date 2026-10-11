---
'@basaltkit/tenancy': major
---

An unknown `meta.tenant` value refuses the boot again.

`tenancyPlugin` registers an `http:meta-validators` entry: a `meta.tenant` other than `true`, `false`, `'never'` or absent (a typo such as `'none'`, `'optional'`, `'false'`, `0` or `null`) refuses the boot with `HTTP_INVALID_ROUTE_META` on every adapter, naming each offending route. 3.2 printed one `[basalt] meta.tenant …` warning at `app:booted` and fell back to the app-wide `required` default, so a typo for `'never'` served a platform route on tenant hosts. The fallback and the warning are gone.

**Migrating.** If 3.2 printed the warning, fix the value it named: `'never'` for a central-only route (the SaaS owner's console), `false` for a route that works with or without a tenant, `true` (or nothing) for a tenant route. Apps that only use `true`, `false` and `'never'` are unaffected.
