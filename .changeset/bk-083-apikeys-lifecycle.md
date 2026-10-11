---
'@basaltkit/auth': minor
---

BK-083 (c)/(e)/(f): API key lifecycle, service keys, and per-key IP allowlist and metadata.

- **Rotation with grace.** `ApiKeys.rotate(id, { graceMs })` replaces a key's secret and keeps its id, owner, scopes and audit trail. With `graceMs` the replaced secret keeps working that long. It is capped at `MAX_API_KEY_ROTATION_GRACE_MS` (30 days, the webhooks secret-rotation cap), never outlives the key's own expiry or revocation, and only two secrets are ever live. The default `0` kills the old secret now. Rotation is a compare-and-set: a concurrent rotation or revocation makes it throw `409 AUTH_APIKEY_CONFLICT`.
- **Expiry and edits.** `ApiKeys.update(id, { name, scopes, expiresAt, allowedIps, meta })` validates everything and then writes once. `null` clears a field; `expiresAt: null` means the key never expires. `setExpiry(id, expiresAt | null)` is a thin wrapper over it. An expired key is dead for `rotate`, `update` and `setExpiry` alike (`404 AUTH_APIKEY_NOT_FOUND`), so it cannot be renewed: issue a new one.
- **Listing.** `list({ includeExpired: true })` also returns keys past their expiry; revoked keys are never listed. `ApiKeys.list` now re-applies `tenantId`, `userId` and `serviceId` itself, so a custom store that ignores a filter field never widens a result.
- **Service keys.** `issue({ serviceId })` mints a key that acts as a non-human actor. `serviceId` is opaque, 1-128 printable characters, immutable, and mutually exclusive with `userId`. It shows up as `ctx().apiKey.serviceId` and never sets `ctx().user`, so a service key is authorized by its scopes and tenant binding only, and identity-gated routes (`meta.auth`, `meta.can`) stay closed to it. Service keys are programmatic only: `apiKeyRoutes()` neither mints nor manages them.
- **IP allowlist.** `allowedIps` holds up to 32 addresses or CIDR networks. They are validated and canonicalised: IPv4-mapped IPv6 becomes IPv4, and a CIDR with host bits set or a zone id is refused. The enricher checks the address the adapter resolved. A key used from outside its list, or with no resolvable address, is always refused with `403 AUTH_APIKEY_IP_NOT_ALLOWED`, whatever `rejectInvalid` says; `ctx().apiKey` is not set and `lastUsedAt` is not touched. Only the key holder can cause it, so besides `auth:apikey_rejected` it is emitted as `auth:apikey_refused` (`reason: 'ip_not_allowed'`), which `@basaltkit/audit` records by default.
- **Metadata.** `meta` is a flat string map (at most 20 keys of 40 characters and values of 500; `__proto__`, `constructor` and `prototype` are refused). It is never used for authorization.
- **New API.**
  - `ApiKeys.authenticate(presented, { ip })` returns `{ ok, record }` or a `reason` (`invalid` / `ip_not_allowed`). `verify(presented, { ip })` keeps its signature.
  - Routes: `PATCH /apikeys/:id`, `POST /apikeys/:id/rotate` and `GET /apikeys?includeExpired=true`. They are session-only and scoped like the existing ones, on every adapter. `POST /apikeys` also accepts `allowedIps` and `meta`.
  - Hooks: `auth:apikey_rotated` and `auth:apikey_updated` (field names only, never values). `auth:apikey_issued` gains `serviceId`.
  - Errors, all exported: `ApiKeyNotFoundError` (`AUTH_APIKEY_NOT_FOUND`, the same code the routes already answered with), `ApiKeyInputError` (400 `AUTH_APIKEY_INPUT_INVALID`), `ApiKeyConflictError` (409), `ApiKeyStoreUnsupportedError` (501) and `ApiKeyIpNotAllowedError` (403).
  - Constants: `MAX_API_KEY_ROTATION_GRACE_MS`, `API_KEY_ALLOWED_IPS_MAX` and `API_KEY_META_LIMITS`.
- **Store contract (additive).**
  - `ApiKeyRecord` gains `serviceId`, `previousHash`, `previousHashExpiresAt`, `rotatedAt`, `allowedIps` and `meta`. `ApiKeyFilter` gains `serviceId`. There are new `ApiKeyPatch` and `ApiKeyUpdateOptions` types.
  - A new OPTIONAL `ApiKeyStore.update(id, patch, { ifHash })`. A store that implements it must also find a record by its `previousHash` in `findByHash`. A store without it keeps working, and lifecycle calls answer `501 AUTH_APIKEY_STORE_UNSUPPORTED`.
  - `MemoryApiKeyStore` implements `update` and now returns detached copies, as a database does.

Watch for:

- The `auth:apikey_rejected` and `auth:apikey_refused` `reason` unions gain `'ip_not_allowed'`. An exhaustive `switch` with a `never` check needs a new case.
- `ApiKeyInfo` now also omits `previousHash`, so no hash ever reaches a listing or a response.
