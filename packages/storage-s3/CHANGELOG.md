# @basaltkit/storage-s3

## 1.2.0

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

## 1.1.0

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

## 1.0.1

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/storage@3.0.0

## 1.0.0

### Major Changes

- e19b765: **New package: the S3-compatible driver for `@basaltkit/storage`**, extracted
  from the core so consumers who do not use S3 stop installing the AWS SDK.
  
  ```bash
  pnpm add @basaltkit/storage-s3 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
  ```
  
  ```ts
  import { s3Disk } from '@basaltkit/storage-s3'
  
  storagePlugin({ disks: { uploads: s3Disk({ bucket: 'my-app', region: 'eu-west-1' }) } })
  ```
  
  Exports `s3Disk()`, `S3StorageDriver` and `S3DriverOptions`. Works with AWS S3,
  MinIO, Cloudflare R2 and anything else speaking the S3 API — set `endpoint` and
  `forcePathStyle` flips to `true` automatically.
  
  The driver code is unchanged from `@basaltkit/storage`; this is a move, and its
  tests moved with it. The AWS packages are peer dependencies, which is what keeps
  them out of the trees of apps on local, Azure or GCS.

### Patch Changes

- Updated dependencies [e19b765]
  - @basaltkit/storage@2.0.0
