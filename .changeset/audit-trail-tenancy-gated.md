---
'@basaltkit/audit': minor
---

`trail()` no longer requires tenancy: it fails closed only when `@basaltkit/tenancy` is registered.

`Audit.trail()` threw whenever it could not resolve a tenant — but in an app with no `tenancyPlugin`, `ctx().tenant` is *always* undefined, so the everyday read threw every time and pushed developers onto `systemTrail()`, which the docs (correctly) frame as a dangerous system-only escape hatch. `@basaltkit/audit` is a general-purpose package; requiring the opt-in SaaS layer to read your own audit trail broke the [beyond-SaaS](https://basalt.dev/guide/beyond-saas) promise.

`auditPlugin` now reads tenancy's `tenancy:active` metadata marker — the same signal `@basaltkit/cache` uses — and passes it to `Audit`. A **signal, not an import**: `@basaltkit/audit` still has no dependency on `@basaltkit/tenancy`.

| App | `trail()` with no context tenant and no `tenantId` |
|---|---|
| No `tenancyPlugin` | Returns the trail (**changed** — used to throw) |
| `tenancyPlugin` registered | Still throws, pointing at `systemTrail()` (unchanged) |

Everything else is untouched: a context tenant still FORCES the scope and a caller-supplied `tenantId` still cannot widen it, an explicit `trail({ tenantId })` is still honoured, and `systemTrail()` remains the deliberate cross-tenant read. Multi-tenant apps see no behavior change; single-tenant apps get a bug fix. `new Audit(store, redact, tenancyActive?)` takes an optional third argument (defaults to single-tenant).
