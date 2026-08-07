---
'@machize/files': minor
---

New package: `@machize/files` — an upload pipeline over `@machize/storage`.

`Files.upload(buffer, input)` validates content type and size, enforces a per-tenant storage quota (a built-in `maxTotalBytes` and/or a custom `checkQuota` hook for wiring `@machize/subscriptions`), writes the bytes tenant-scoped, records metadata (name, size, SHA-256 checksum, uploader), and emits `file:uploaded`. Also `download`, `temporaryUrl` (signed), `get`/`list`, `delete` (emits `file:deleted`), and `markScanned` (emits `file:scanned`) for out-of-band antivirus/thumbnail steps. Storage access runs in the resolved tenant's context so files stay isolated even from a background job. `filesPlugin({ disk, validate, maxTotalBytes, checkQuota, store })` registers the service; `fileRoutes()` exposes list/metadata/signed-URL/delete (uploading is multipart, so it's called from your own handler). `FileStore` (with `MemoryFileStore`) persists metadata. Fully unit-tested with a fake storage driver.
