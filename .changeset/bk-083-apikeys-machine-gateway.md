---
'@basaltkit/auth': minor
---

BK-083: API keys for machine clients.

- `apiKeysPlugin({ rejectInvalid: true })` refuses a presented key that does not verify (unknown, revoked, expired, malformed) with `401 AUTH_APIKEY_INVALID` and `WWW-Authenticate: Bearer error="invalid_token"`, before any guard, on every adapter. Default `false` keeps the request anonymous, as before. New `ApiKeyInvalidError`.
- `touchEveryMs` (default `60_000`) throttles `lastUsedAt` writes to one per key per window instead of one per request; `0` restores a write per verification. New `ApiKeyOptionsError` for an invalid value and `DEFAULT_API_KEY_TOUCH_EVERY_MS`.
- `auth:apikey_rejected` for an invalid key now carries the presented key's display `prefix` (`mk_live_` + 6 characters, never the secret; omitted for anything not shaped like a Basalt key) and the client `ip`.
