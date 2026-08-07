# @machize/api-keys-ui

## 0.17.0

### Minor Changes

- 261bd51: New package: `@machize/api-keys-ui` — a management page for `@machize/auth` API keys.

  `apiKeysUiRoutes({ path?, apiBase?, title? })` serves a self-contained, dependency-free HTML page at `GET /apikeys/ui` (requires a logged-in user) that drives `@machize/auth`'s `GET/POST /apikeys` and `DELETE /apikeys/:id`: list keys with their prefix, scopes and last-used, create a new key (revealing the plaintext exactly once, with a copy button and a warning), and revoke. `apiKeysPageHtml(...)` returns the HTML string directly for custom serving. The page fetches same-origin, so it assumes the browser session is already authenticated. Tested (the generated page and the end-to-end HTTP flow against the real auth routes).

### Patch Changes

- @machize/core@0.17.0
- @machize/fastify@0.17.0
