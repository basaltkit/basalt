# @basaltkit/storage-azure

## 1.2.0

### Minor Changes

- fb85c40: Security hardening (B06, tenant isolation):
  
  - `@basaltkit/tenancy`: tenant ids now follow a canonical grammar (`/^[a-z0-9][a-z0-9_-]{0,62}$/`, `global` reserved). `tenancy.create()` and `MemoryTenantSource.create()/save()` refuse other ids with `InvalidTenantIdError` (`TENANT_ID_INVALID`, 400) before anything is written, so an id cannot smuggle a namespace delimiter into downstream keys. New exports `isValidTenantId`, `assertValidTenantId`, `TENANT_ID_PATTERN`, `RESERVED_TENANT_IDS`; override with `tenancyPlugin({ validateTenantId })` / `new MemoryTenantSource({ validateTenantId })`.
  - `@basaltkit/tenancy`: `tenantScoped(where)` no longer falls back to a `tenantId` found in `where` when no tenant is in context; it throws `TenantRequiredError`. System code pins a tenant with `requireTenantId(id)` or `tenancy.run(id, …)`.
  - `@basaltkit/storage`: with `@basaltkit/tenancy` registered, a disk on the default tenant scope fails closed (`StorageTenantRequiredError`, `STORAGE_TENANT_REQUIRED`, 400) instead of falling back to the bucket root when no tenant is in context. Central disks opt out explicitly with `scope: null` or the new `onMissingScope: 'root'`. A tenant id that is not a single safe path segment is refused (`StorageInvalidScopeError`).
  - `@basaltkit/storage`: `temporaryUrl` lifetimes are capped at 7 days by default (`maxTemporaryUrlTtl` per disk); longer or non-positive lifetimes throw `TemporaryUrlTtlTooLongError` (`STORAGE_TEMPORARY_URL_TTL`, 400). `Disk.temporaryUrl` now always returns a rejected promise instead of throwing synchronously.
  - `@basaltkit/storage-azure`: SAS URLs are capped at 7 days (Azure has no native limit), also when the driver is called directly.
  - `@basaltkit/cache`: the tenant id is encoded in the default scope segment so an id containing `:` cannot address another tenant's keys. Key layout for valid ids is unchanged.
  - `@basaltkit/realtime`: the hub's (tenant, channel) map key is now injective, so a crafted tenant id cannot share another tenant's channel.
  - `@basaltkit/storage` / `@basaltkit/cache`: the fail-closed default no longer depends on plugin order. Whether tenancy is active is checked lazily on every operation, so a disk or cache resolved before `tenancyPlugin` registers still refuses tenant-less access (it used to keep the unscoped fallback for the life of the app).
  - `@basaltkit/realtime`: registering a connection id that is already in use by a different connection unregisters the previous one first, so a reused id never inherits another tenant's subscriptions.

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/storage@3.0.0

## 1.1.2

### Patch Changes

- Updated dependencies [e19b765]
  - @basaltkit/storage@2.0.0

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/storage@1.3.1

## 1.1.0

### Minor Changes

- 8a3e92a: **Security: signed download URLs default to `Content-Disposition: attachment`; uploads get a default size cap.**
  
  **What was exposed.** Uploads trusted the client's declared Content-Type end-to-end and `temporaryUrl` presigned bare GET URLs, so an uploaded `text/html`/`image/svg+xml` object rendered top-level on the storage/CDN origin — stored XSS when that origin is CNAME'd onto the app domain. `Files` validation also defaulted to open (no size cap).
  
  **What changed.** `Disk.temporaryUrl` (and the S3/Azure/GCS drivers) now pin `Content-Disposition: attachment` on every signed URL by default; top-level inline rendering is a deliberate opt-in — `temporaryUrl(path, expiresIn, { disposition: 'inline' })` (also threaded through `Files.temporaryUrl`). Embedded uses (`<img>`, `<video>`) are unaffected by disposition, so avatars/previews inside pages keep working. `Files` uploads are capped at 25 MiB by default (`DEFAULT_MAX_FILE_SIZE`, new export) when no `validate.maxSize` is configured — raise or override explicitly. A MIME denylist was deliberately **not** added: the disposition pin closes the render-time vector at the right layer without breaking legitimate HTML/SVG storage. Custom `StorageDriver` implementations: `temporaryUrl` gains an optional third parameter (`TemporaryUrlOptions`, new export) — implementations that ignore it keep compiling but should honor it.

### Patch Changes

- Updated dependencies [8a3e92a]
  - @basaltkit/storage@1.3.0

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

- Updated dependencies [be55f2d]
  - @basaltkit/storage@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/storage@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/storage@0.22.0

## 0.21.0

### Minor Changes

- b0ac861: New packages: `@basaltkit/storage-gcs` and `@basaltkit/storage-azure` — cloud storage drivers for `@basaltkit/storage`.

  `GcsStorageDriver` (Google Cloud Storage, via `@google-cloud/storage`) and `AzureBlobStorageDriver` (Azure Blob Storage, via `@azure/storage-blob`) implement the `StorageDriver` contract — `put`/`get`/`exists`/`delete`/`list` and signed URLs (`temporaryUrl`; SAS on Azure) — so they drop into any `Disk`/`storagePlugin` with tenant isolation, alongside the built-in S3 and local drivers. Each takes an injectable client (bucket/container), so the whole driver is unit-tested with fakes — no cloud account needed. The SDKs are optional peer dependencies.

### Patch Changes

- @basaltkit/storage@0.21.0
