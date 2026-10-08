---
'@basaltkit/http': minor
'@basaltkit/cli': minor
---

Route security review (BK-025). `@basaltkit/http` adds `describeRoutes()` — a pure normaliser of the `http:routes` bucket into rows with each route's declared `auth`, `can`, `rateLimit`, `tenant` (`'required'`, `'exempt'`, `'central-only'` for `meta.tenant: 'never'`, `'central'`, or `null` when undeclared), `public` and other guarded keys — and `findUnguardedRoutes()`, which lists the routes missing required guards (explicit opt-outs such as `auth: false` pass; only `auth: true`, the value `authPlugin` enforces, counts as `auth`). Both are also exported from the zod-free subpath `@basaltkit/http/route-table`, so a test can assert on the route table after `app.boot()` without listening. `basalt routes` now prints a column per guard, `--json` prints the rows as one JSON array, and `--unguarded --require=auth,can [--allow=<glob,…>]` lists offenders and exits 1. It checks route meta only: app-wide rate limits, URL-based tenancy, app hooks and edge routes (health, metrics, openapi) are not visible to it. `@basaltkit/cli` now depends on `@basaltkit/http` (it imports only the zod-free subpath).
