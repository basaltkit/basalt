# @basaltkit/billing-ui

## 1.1.2

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0
  - @basaltkit/subscriptions@3.0.0

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1
  - @basaltkit/subscriptions@2.8.1

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
- Updated dependencies [3d09275]
  - @basaltkit/subscriptions@2.6.2

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

- @basaltkit/core@0.24.0
- @basaltkit/fastify@0.24.0
- @basaltkit/subscriptions@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0
- @basaltkit/subscriptions@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0
- @basaltkit/subscriptions@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0
- @basaltkit/subscriptions@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0
- @basaltkit/subscriptions@0.20.0

## 0.19.0

### Minor Changes

- 3ae1c5a: New package: `@basaltkit/billing-ui` — a subscription page for `@basaltkit/subscriptions`.

  `billingUiRoutes({ plans, path?, apiBase?, title?, headers? })` serves a self-contained, dependency-free HTML page at `GET /billing/ui` plus its data at `GET /billing/info` (`{ subscription, plans }` for the current tenant). The page shows the active plan with its status and trial, lists the plans as cards, and wires Subscribe/Switch to `POST /billing/checkout` (hosted Checkout) and Manage-billing to `POST /billing/portal` (Customer Portal) — both from `@basaltkit/subscriptions`' `billingRoutes()`. It fetches same-origin with optional injected headers for header-based tenancy. `billingPageHtml(...)` returns the HTML for custom serving. Tested (the page and the end-to-end HTTP flow: info before/after subscribing, checkout and portal via the fake gateway).

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0
- @basaltkit/subscriptions@0.19.0
