# @basaltkit/audit-viewer

## 2.0.0

### Major Changes

- d5ca076: **Zod 3 is no longer supported.** These packages now require zod 4.
  
  The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
  change for any application still on zod 3: the install will refuse the peer
  rather than fail somewhere subtle at runtime, which is the point of declaring it.
  
  The move itself was overdue — the repository has been testing against zod 4 only
  for some time, through a workspace override, so the second half of that range was
  a claim nobody was checking. Supporting a major version you never run is worse
  than not supporting it: it holds back the API surface (a schema written against
  zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
  compatibility that would break on first contact.
  
  **Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
  migration guide covers the API changes; the ones that touch Basalt users most are
  `z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
  moving from `message`/`invalid_type_error` to a single `error` parameter.
  
  The peer asks for `^4.0.0` and not the version this repo happens to test —
  requiring the newest 4.x would force every consumer to move in step with us for
  no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
  so its range narrowing is not breaking for anyone.
  
  **The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
  `switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
  `z.toJSONSchema` does natively — reachable only when the native converter was
  absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
  `_def` for every introspection. Both are gone, along with the coverage test
  that existed solely to drive the dead path by mocking zod's converter away.
  
  `create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
  generated after this change would have failed its own install against the new
  peer; it now scaffolds `^4.0.0`.

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/audit@1.4.1
  - @basaltkit/http@2.0.0

## 1.3.0

### Minor Changes

- f3703a1: The viewer works in apps without tenancy.
  
  `AuditViewer.page()`, `stats()` and `get()` all resolved a tenant through a `tenant()` helper that threw `AuditTenantRequiredError` (`400 AUDIT_TENANT_REQUIRED`) whenever none could be found — so in an app with no `tenancyPlugin` every read, and every mounted `/audit*` route, returned 400 forever.
  
  `auditViewerPlugin` now reads tenancy's `tenancy:active` metadata marker (a signal, not an import — no dependency on `@basaltkit/tenancy`) and only fails closed when tenancy is actually registered. Without it, reads are unscoped, which is correct: there is no tenant dimension to cross. With it, behavior is unchanged. `new AuditViewer(audit, options, tenancyActive?)` takes an optional third argument.

### Patch Changes

- Updated dependencies [f3703a1]
  - @basaltkit/audit@1.4.0

## 1.2.0

### Minor Changes

- 104cfb3: The viewer bounds how much of the trail it reads, and says when it hit the bound.
  
  `page()`, `get()` and `stats()` all called `audit.trail()` with no limit — the aggregates genuinely need more than one page, but "all of it" is unbounded on a trail that only ever grows. Every call now reads at most `maxScan` rows (default **10 000**, configurable on `auditViewerPlugin`/`new AuditViewer`).
  
  `AuditPage` and `AuditStats` gain `truncated: boolean`, true when the scan hit the bound — so `total` is honestly "matches within the window" rather than a silently wrong grand total, and a UI can say so. Trails smaller than `maxScan` behave exactly as before.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/audit@1.3.0
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1

## 1.1.0

### Minor Changes

- cc4786e: **Security (S-5): standardized escaping, `</script>`-safe embedded state, and a hash-locked route-scoped CSP by default.**
  
  **What was exposed (latent).** Three of the four pages' client-side `esc()` helpers omitted `"` yet were used inside double-quoted attributes — an attribute-breakout XSS trap the moment API data carries a quote; server-side `title`/`roles` were interpolated unescaped; and `JSON.stringify`'d state (`apiBase`, `headers`, `roles`) could terminate the inline `<script>` block (`JSON.stringify` does not escape `/`). Separately — and live — every page ships inline style/script that `securityPlugin`'s `DEFAULT_CSP` blocks, with no documented alternative, pushing operators toward `contentSecurityPolicy: false` app-wide.
  
  **What changed.** All four pages: server-side interpolations go through the shared `escapeHtml` (`@basaltkit/http`); embedded state uses `scriptJson` (cannot break out of the script block); the client-side `esc()` charset is unified to `& < > " '`. Each route now sets a route-scoped CSP by default — everything denied, the page's own inline script allowed only by sha256 hash (new exports `apiKeysPageCsp`/`teamsPageCsp`/`billingPageCsp`/`auditViewerCsp`; new route option `csp: string | false` to override or opt out). The pages now work under the strict app-wide CSP without weakening it.

### Patch Changes

- Updated dependencies [cc4786e]
  - @basaltkit/http@1.11.0

## 1.0.2

### Patch Changes

- 3d09275: Depend on the neutral HTTP contract, not the Fastify adapter.
  
  The package imported `route`/`BasaltRoute`/`RouteGuard`/`RequestEnricher` through `@basaltkit/fastify`, which merely re-exports them from `@basaltkit/http` — but carries a hard `fastify` dependency. Imports now come straight from `@basaltkit/http`, and the runtime dependency swaps `@basaltkit/fastify` → `@basaltkit/http` (`@basaltkit/fastify` stays as a devDependency for the test suite). Express and Hono apps no longer install Fastify transitively through this package. No public API change — the symbols are byte-identical re-exports.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/audit@0.24.0
- @basaltkit/core@0.24.0
- @basaltkit/fastify@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/audit@0.23.0
- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/audit@0.22.0
- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/audit@0.21.0
- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/audit@0.20.0
- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/audit@0.19.0
- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/audit@0.18.0
- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/audit@0.17.0
- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0

## 0.16.0

### Minor Changes

- ca0d911: New package: `@basaltkit/audit-viewer` — a read-only lens over the `@basaltkit/audit` trail.

  `AuditViewer` wraps `Audit` to give tenant-scoped, filterable, paginated queries (`page`) and aggregate stats (`stats`: by event, by actor, by source, and a bucketed timeline), plus `get(id)`. `ViewerQuery` filters by event wildcard, actor, source (`hook`/`event`/`manual`) and a `since`/`until` time range; the tenant comes from the argument or the request context. `auditViewerRoutes()` exposes `GET /audit`, `/audit/stats`, `/audit/:id` and a self-contained, dependency-free HTML browser at `/audit/view` (filters, table, pagination), all requiring a logged-in user. `auditViewerPlugin({ bucketMs, topN })` registers the `AUDIT_VIEWER` token. The trail stays append-only — this package only reads. Fully unit-tested (paging, filters, stats, the HTML page, and the HTTP routes).

### Patch Changes

- @basaltkit/audit@0.16.0
- @basaltkit/core@0.16.0
- @basaltkit/fastify@0.16.0
