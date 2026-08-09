# @basaltkit/storage-gcs

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
