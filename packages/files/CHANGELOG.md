# @machize/files

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.24.0

### Patch Changes

- Updated dependencies [be55f2d]
  - @machize/storage@0.24.0
  - @machize/core@0.24.0
  - @machize/fastify@0.24.0

## 0.23.0

### Patch Changes

- @machize/core@0.23.0
- @machize/fastify@0.23.0
- @machize/storage@0.23.0

## 0.22.0

### Patch Changes

- @machize/core@0.22.0
- @machize/fastify@0.22.0
- @machize/storage@0.22.0

## 0.21.0

### Patch Changes

- @machize/core@0.21.0
- @machize/fastify@0.21.0
- @machize/storage@0.21.0

## 0.20.0

### Patch Changes

- @machize/core@0.20.0
- @machize/fastify@0.20.0
- @machize/storage@0.20.0

## 0.19.0

### Patch Changes

- @machize/core@0.19.0
- @machize/fastify@0.19.0
- @machize/storage@0.19.0

## 0.18.0

### Patch Changes

- @machize/core@0.18.0
- @machize/fastify@0.18.0
- @machize/storage@0.18.0

## 0.17.0

### Patch Changes

- @machize/core@0.17.0
- @machize/fastify@0.17.0
- @machize/storage@0.17.0

## 0.16.0

### Patch Changes

- @machize/core@0.16.0
- @machize/fastify@0.16.0
- @machize/storage@0.16.0

## 0.15.0

### Patch Changes

- @machize/core@0.15.0
- @machize/fastify@0.15.0
- @machize/storage@0.15.0

## 0.14.0

### Patch Changes

- @machize/core@0.14.0
- @machize/fastify@0.14.0
- @machize/storage@0.14.0

## 0.13.0

### Patch Changes

- @machize/core@0.13.0
- @machize/fastify@0.13.0
- @machize/storage@0.13.0

## 0.12.0

### Minor Changes

- 74107c7: New package: `@machize/files` — an upload pipeline over `@machize/storage`.

  `Files.upload(buffer, input)` validates content type and size, enforces a per-tenant storage quota (a built-in `maxTotalBytes` and/or a custom `checkQuota` hook for wiring `@machize/subscriptions`), writes the bytes tenant-scoped, records metadata (name, size, SHA-256 checksum, uploader), and emits `file:uploaded`. Also `download`, `temporaryUrl` (signed), `get`/`list`, `delete` (emits `file:deleted`), and `markScanned` (emits `file:scanned`) for out-of-band antivirus/thumbnail steps. Storage access runs in the resolved tenant's context so files stay isolated even from a background job. `filesPlugin({ disk, validate, maxTotalBytes, checkQuota, store })` registers the service; `fileRoutes()` exposes list/metadata/signed-URL/delete (uploading is multipart, so it's called from your own handler). `FileStore` (with `MemoryFileStore`) persists metadata. Fully unit-tested with a fake storage driver.

### Patch Changes

- @machize/core@0.12.0
- @machize/fastify@0.12.0
- @machize/storage@0.12.0
