# @basaltkit/storage-gcs

## 1.3.0

### Minor Changes

- 7363b76: Streaming storage: `putStream` / `getStream` / `copy` / `stat`, plus a signing-endpoint override for pre-signed URLs (BK-019, BK-005 phase 2).
  
  **`@basaltkit/storage`** — four new optional driver capabilities on the `Disk` facade, with the same safety rules as `put` (key validation, tenant scope prefix, fail-closed without a tenant, `maxBytes` / `allowedContentTypes`):
  
  - `disk.putStream(key, source, { contentType, contentLength?, maxBytes?, allowedContentTypes? })` — `source` is a Node `Readable`, a web `ReadableStream` or any `AsyncIterable<Uint8Array | string>`. The facade normalizes it into one Node `Readable` that enforces `maxBytes` **while it streams**: past the cap the upload aborts with `StorageTooLargeError` and the source is destroyed (Node) or cancelled (web). `contentType` and a declared `contentLength` over `maxBytes` are refused before a byte is read.
  - `disk.getStream(key)` — a Node `Readable`; the caller must consume or `destroy()` it. A missing object throws the existing `StorageFileNotFoundError`.
  - `disk.copy(from, to, { disk?, contentType?, maxBytes?, requireServerSide? })` — server-side within one driver; otherwise `getStream` → `putStream`, then `get` → `put`. Both keys are validated and scoped, the destination against the destination disk. `requireServerSide: true` turns a fallback into `CopyUnsupportedError`.
  - `disk.stat(key)` — `{ size, contentType?, etag?, lastModified? }`.
  - `disk.supports('putStream' | 'getStream' | 'copy' | 'stat' | 'temporaryUrl' | 'temporaryUploadUrl')` so callers can branch instead of catching.
  - New errors: `PutStreamUnsupportedError` (`STORAGE_PUT_STREAM_UNSUPPORTED`), `GetStreamUnsupportedError` (`STORAGE_GET_STREAM_UNSUPPORTED`), `CopyUnsupportedError` (`STORAGE_COPY_UNSUPPORTED`), `StatUnsupportedError` (`STORAGE_STAT_UNSUPPORTED`), `StorageStreamLengthRequiredError` (400 `STORAGE_STREAM_LENGTH_REQUIRED`), `StorageSigningEndpointInvalidError` (400 `STORAGE_SIGNING_ENDPOINT_INVALID`). New exports: `StreamSource`, `PutStreamOptions`, `PutStreamInput`, `CopyOptions`, `CopyDriverOptions`, `StorageStat`, `toLimitedReadable`, `collectStream`. `LocalStorageDriver` implements all four (fs streams, `fs.copyFile`, `fs.stat`), removing a partial file when a streaming upload fails.
  - `temporaryUrl` / `temporaryUploadUrl` accept an `endpoint` override, validated at the facade (absolute `http(s)`, no credentials, no query/fragment). A driver that cannot sign for another endpoint must refuse it rather than ignore it.
  
  **`@basaltkit/storage-s3`** — `putStream` (PutObject: streams through with a known `contentLength`, buffers up to `maxBytes` without one, else `STORAGE_STREAM_LENGTH_REQUIRED`; `@aws-sdk/lib-storage` is deliberately not added as a dependency), `getStream` (GetObject body, web-stream bodies wrapped), `copy` (CopyObject, SSE re-applied, `MetadataDirective: 'REPLACE'` with a content type) and `stat` (HeadObject). New `signingEndpoint` driver option and per-call `endpoint`: pre-signed URLs are signed for another host of the same bucket — an internal MinIO name, a CDN alias — keeping region, path style, credentials, SSE and the signed content-type/length/checksum headers unchanged.
  
  **`@basaltkit/storage-azure`** — `putStream` (`uploadStream`, any length), `getStream` (`download()`), `copy` (`syncCopyFromURL` through a 5-minute read-only SAS; Azure caps it at 256 MiB) and `stat` (`getProperties`). An `endpoint` override is refused with the unsupported error: a SAS is derived from the blob client's account host.
  
  **`@basaltkit/storage-gcs`** — `putStream` (`createWriteStream`, any length), `getStream` (`createReadStream`; a missing object surfaces as `STORAGE_FILE_NOT_FOUND` on the stream), `copy` (`file.copy`) and `stat` (`getMetadata`, string size coerced). An `endpoint` override is refused: V4 signatures are bound to the bucket host.
  
  **`@basaltkit/files`** — `upload()` now streams straight to the backend when the driver supports `putStream`, keeping `maxSize`, the SHA-256 and BK-003 sniffing (the first 64 KiB are read to decide the type, then the body continues streaming); the built-in `maxTotalBytes` quota becomes a second mid-stream limit. The buffered path stays as the fallback (no `putStream`, an unbounded `maxSize` with no declared length, or a custom `checkQuota`, which needs the size up front), so existing `Buffer` callers are unaffected. A failed streaming upload deletes whatever reached the disk. New `UploadInput.contentLength` (the client's declared size — a hint that lets S3 stream instead of buffer; the real size is always measured) and new `files.downloadStream(id, tenantId?, { bypassQuarantine? })`, mirroring `download()` including the BK-004 quarantine gate.
  
  **`@basaltkit/backup`** — dumps are no longer buffered: `create()` measures and hashes the temporary `pg_dump` file in chunks and streams it to the disk with a known `contentLength`; `restore()` streams the artifact to a temporary file and still verifies its SHA-256 before `pg_restore` runs. Disks whose driver cannot stream keep the previous whole-file behaviour.

### Patch Changes

- Updated dependencies [7363b76]
  - @basaltkit/storage@3.2.0

## 1.2.0

### Minor Changes

- b0cc59f: Pre-signed direct uploads and an `s3Disk` security fix.
  
  - **fix (storage-s3, BK-015):** `s3Disk({...})` forwarded only `scope` to the disk and silently dropped every other `DiskOptions` field — `onMissingScope` and `maxTemporaryUrlTtl` were lost without error. It now splits driver options from disk options by the driver's own key list, so every disk option (current and future) reaches the `Disk`.
  - **feat (storage, BK-005):** optional driver capability `temporaryUploadUrl(path, expiresInMs, { contentType, contentLength?, checksumSha256? })`, exposed as `disk.temporaryUploadUrl(key, { expiresIn, contentType, contentLength?, checksumSha256?, maxBytes?, allowedContentTypes? })` returning `{ url, method: 'PUT', headers, expiresAt, key }`. Same safety rules as `temporaryUrl`: key validation, tenant prefix, fail-closed without a tenant, and a lifetime cap via the new `maxTemporaryUploadUrlTtl` disk option (default 1 hour, or `maxTemporaryUrlTtl` when lower). `contentType` is required. New errors `TemporaryUploadUrlUnsupportedError` (`STORAGE_UPLOAD_URL_UNSUPPORTED`) and `StorageUploadUrlInvalidError` (`400 STORAGE_UPLOAD_URL_INVALID`); new export `DEFAULT_MAX_TEMPORARY_UPLOAD_URL_TTL`.
  - **feat (storage-s3):** presigned `PutObject` with Content-Type, Content-Length, `x-amz-checksum-sha256` and SSE headers signed as headers (not hoisted), presigned without the SDK's default empty-body CRC32 checksum. New `serverSideEncryption: 'AES256' | { kms }` driver option applied to every put and every presigned upload.
  - **feat (storage-azure):** create/write-only SAS upload URL (header binding is not possible on Azure — documented); `checksumSha256` refused.
  - **feat (storage-gcs):** V4 signed `write` URL binding Content-Type and `x-goog-content-length-range`; `checksumSha256` refused. `GcsFileLike.getSignedUrl` now takes the exported `GcsSignedUrlConfig`.

### Patch Changes

- Updated dependencies [b0cc59f]
  - @basaltkit/storage@3.1.0

## 1.1.3

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
