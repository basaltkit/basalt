---
'@machize/auth': minor
---

Add API keys for programmatic, tenant-scoped access.

- New `ApiKeys` service: `issue`, `verify`, `list`, `revoke`, `get`. The plaintext key (`mk_live_…`) is returned exactly once; only its SHA-256 hash and a short display prefix are stored.
- New `apiKeysPlugin({ store?, header?, users? })`: an enricher that authenticates `Authorization: Bearer mk_…` (or the `x-api-key` header) onto `ctx().apiKey`, and a guard enforcing `meta.scopes` on routes (`*` grants all). Emits `auth:apikey_issued` / `auth:apikey_revoked` for audit.
- New `apiKeyRoutes()`: `POST /apikeys`, `GET /apikeys`, `DELETE /apikeys/:id`, all requiring a logged-in user and scoped to the caller's tenant + user.
- New store contract `ApiKeyStore` with `MemoryApiKeyStore`; `scopesSatisfy()` helper and `ScopeRequiredError` (403).
- The existing JWT enricher now ignores `mk_`-prefixed bearers so keys and JWTs coexist on the same header.
