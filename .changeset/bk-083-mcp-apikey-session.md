---
'@basaltkit/mcp': major
---

BK-083: a `/mcp` session opened by a request authenticated with a userless API key is now bound to that key (`ctx().apiKey.id`, in its tenant). Before, such callers carry no `ctx().user` and no `Authorization` header when the key travels in `x-api-key`, so every one of them bound to the same anonymous fingerprint and a leaked `mcp-session-id` was accepted for a different key. A session is now refused (404) for another key or for an anonymous caller. Sessions opened by a user are unchanged; the key is read by duck-typing, with no new dependency.

**Why a major.** `@basaltkit/mcp` now requires `@basaltkit/http` 3. It runs the app's routes as tools through its own copy of the http pipeline (`runRoute`, `toErrorResponse`, `isRouteVisible`), with the guards and enrichers the app's other plugins registered, so it must be the same `@basaltkit/http` the app's adapter runs: next to an http 2.x adapter, an MCP tool call would apply http 3's rules (for example the `meta.responseHeaders` refusal) where the HTTP route does not. Upgrade it together with `@basaltkit/http` 3 and a 3.x adapter. No API of the package itself changes.
