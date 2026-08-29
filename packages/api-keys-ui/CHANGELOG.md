# @basaltkit/api-keys-ui

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

- @basaltkit/core@0.24.0
- @basaltkit/fastify@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0

## 0.17.0

### Minor Changes

- 261bd51: New package: `@basaltkit/api-keys-ui` — a management page for `@basaltkit/auth` API keys.

  `apiKeysUiRoutes({ path?, apiBase?, title? })` serves a self-contained, dependency-free HTML page at `GET /apikeys/ui` (requires a logged-in user) that drives `@basaltkit/auth`'s `GET/POST /apikeys` and `DELETE /apikeys/:id`: list keys with their prefix, scopes and last-used, create a new key (revealing the plaintext exactly once, with a copy button and a warning), and revoke. `apiKeysPageHtml(...)` returns the HTML string directly for custom serving. The page fetches same-origin, so it assumes the browser session is already authenticated. Tested (the generated page and the end-to-end HTTP flow against the real auth routes).

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0
