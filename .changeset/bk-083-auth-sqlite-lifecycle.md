---
'@basaltkit/auth-sqlite': major
---

BK-083: API key lifecycle on SQLite.

`migrate()` adds `service_id`, `previous_hash`, `previous_hash_expires_at`, `rotated_at`, `allowed_ips` and `meta` to `auth_api_keys`, with a unique partial index on `previous_hash` and an index on `service_id`. It is idempotent and runs on every boot, so no manual migration is needed, and existing keys keep working.

`SqliteApiKeyStore`:

- implements `ApiKeyStore.update` as one atomic `UPDATE` on a non-revoked row, with an optional compare-and-set on `hash`, built from a fixed column map;
- also finds a key by its `previous_hash` in `findByHash`;
- filters `list` by `serviceId`.

This backs `@basaltkit/auth`'s rotation with grace, service keys, IP allowlist and metadata.

**Why a major.** The store imports `ApiKeyPatch` and `ApiKeyUpdateOptions` and implements `ApiKeyStore.update`, which only `@basaltkit/auth` 5 defines, so its peer range moves from `@basaltkit/auth` 4.x to `^5`. No API of the package itself is removed; upgrade it together with `@basaltkit/auth` 5.
