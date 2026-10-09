---
'@basaltkit/auth': minor
---

Side-effect-free route-visibility checks for `meta.scopes` and `meta.mfa` (BK-061).

Listing surfaces such as the MCP `tools/list` (`mcpRoutes({ listVisibleOnly })`) now hide tools the caller statically cannot pass:

- `apiKeysPlugin`: hides a `meta.scopes` route when the caller's API key does not hold every scope (or the caller has no key). It also hides a `meta.apiKey: false` route from a caller who holds a key, and an identity-gated route without `meta.scopes` from a narrow key (no `*`, unless `allowNarrowKeysOnUnscopedRoutes`), exactly as the guard refuses them. The check reads only `ctx().apiKey` and never emits `auth:apikey_rejected`.
- `authPlugin`: hides a `meta.mfa: true` route, and every non-exempt authenticated route under `requireMfa: true`, from a signed-in session without `'mfa'` in `ctx().amr`. The check reads only `ctx()`. A `requireMfa` function policy is never called for a listing, so those routes stay listed.

`tools/call` still runs every guard. `subscribed`/`feature` are still not filtered.
