# @machize/storage-azure

## 0.23.0

### Patch Changes

- @machize/storage@0.23.0

## 0.22.0

### Patch Changes

- @machize/storage@0.22.0

## 0.21.0

### Minor Changes

- b0ac861: New packages: `@machize/storage-gcs` and `@machize/storage-azure` — cloud storage drivers for `@machize/storage`.

  `GcsStorageDriver` (Google Cloud Storage, via `@google-cloud/storage`) and `AzureBlobStorageDriver` (Azure Blob Storage, via `@azure/storage-blob`) implement the `StorageDriver` contract — `put`/`get`/`exists`/`delete`/`list` and signed URLs (`temporaryUrl`; SAS on Azure) — so they drop into any `Disk`/`storagePlugin` with tenant isolation, alongside the built-in S3 and local drivers. Each takes an injectable client (bucket/container), so the whole driver is unit-tested with fakes — no cloud account needed. The SDKs are optional peer dependencies.

### Patch Changes

- @machize/storage@0.21.0
