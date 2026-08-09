# @basaltkit/api-keys-ui

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
