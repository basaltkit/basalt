---
'@basaltkit/tenancy': major
'@basaltkit/storage': major
'@basaltkit/storage-azure': minor
'@basaltkit/cache': patch
'@basaltkit/realtime': patch
---

Security hardening (B06, tenant isolation):

- `@basaltkit/tenancy`: tenant ids now follow a canonical grammar (`/^[a-z0-9][a-z0-9_-]{0,62}$/`, `global` reserved). `tenancy.create()` and `MemoryTenantSource.create()/save()` refuse other ids with `InvalidTenantIdError` (`TENANT_ID_INVALID`, 400) before anything is written, so an id cannot smuggle a namespace delimiter into downstream keys. New exports `isValidTenantId`, `assertValidTenantId`, `TENANT_ID_PATTERN`, `RESERVED_TENANT_IDS`; override with `tenancyPlugin({ validateTenantId })` / `new MemoryTenantSource({ validateTenantId })`.
- `@basaltkit/tenancy`: `tenantScoped(where)` no longer falls back to a `tenantId` found in `where` when no tenant is in context; it throws `TenantRequiredError`. System code pins a tenant with `requireTenantId(id)` or `tenancy.run(id, …)`.
- `@basaltkit/storage`: with `@basaltkit/tenancy` registered, a disk on the default tenant scope fails closed (`StorageTenantRequiredError`, `STORAGE_TENANT_REQUIRED`, 400) instead of falling back to the bucket root when no tenant is in context. Central disks opt out explicitly with `scope: null` or the new `onMissingScope: 'root'`. A tenant id that is not a single safe path segment is refused (`StorageInvalidScopeError`).
- `@basaltkit/storage`: `temporaryUrl` lifetimes are capped at 7 days by default (`maxTemporaryUrlTtl` per disk); longer or non-positive lifetimes throw `TemporaryUrlTtlTooLongError` (`STORAGE_TEMPORARY_URL_TTL`, 400). `Disk.temporaryUrl` now always returns a rejected promise instead of throwing synchronously.
- `@basaltkit/storage-azure`: SAS URLs are capped at 7 days (Azure has no native limit), also when the driver is called directly.
- `@basaltkit/cache`: the tenant id is encoded in the default scope segment so an id containing `:` cannot address another tenant's keys. Key layout for valid ids is unchanged.
- `@basaltkit/realtime`: the hub's (tenant, channel) map key is now injective, so a crafted tenant id cannot share another tenant's channel.
- `@basaltkit/storage` / `@basaltkit/cache`: the fail-closed default no longer depends on plugin order. Whether tenancy is active is checked lazily on every operation, so a disk or cache resolved before `tenancyPlugin` registers still refuses tenant-less access (it used to keep the unscoped fallback for the life of the app).
- `@basaltkit/realtime`: registering a connection id that is already in use by a different connection unregisters the previous one first, so a reused id never inherits another tenant's subscriptions.
