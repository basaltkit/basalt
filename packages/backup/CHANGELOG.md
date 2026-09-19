# @basaltkit/backup

## 0.3.0

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
- Updated dependencies [7363b76]
  - @basaltkit/core@1.4.0
  - @basaltkit/storage@3.2.0

## 0.2.1

### Patch Changes

- b0cc59f: Close documentation drift where the docs promised more than the code delivered.
  
  - **exports:** new `exports.stream(definition, data, format, { chunkSize? })` renders CSV/TSV/JSON/NDJSON incrementally — rows are pulled one at a time from an array or `AsyncIterable` and the file is emitted as an `AsyncIterable<Buffer>` in ~64 KiB chunks (byte-identical to `run()`), so memory stays bounded for large datasets. Formatters opt in with the new optional `ExportFormatter.renderStream()`; buffer-only formatters (XLSX, PDF) are rejected with `ExportNotStreamableError` (`EXPORT_NOT_STREAMABLE`, 400). Adds `exports.streamableFormats()`. The README no longer claims that `run()` avoids loading everything into memory: it buffers by design.
  - **exports-xlsx:** README states that the XLSX formatter is buffer-only.
  - **backup:** README no longer calls dump artifacts "immutable" (they are plain `disk.put()` writes); documents how to get immutability with bucket versioning + S3 Object Lock as the application's responsibility.
  - **comments:** README mention-notification example uses the real `notifier.notify(recipient, definition, data)` API instead of a non-existent `notifications.to(...).send(...)`.
  - **search:** README documents every driver — including `@basaltkit/search-postgres` and `@basaltkit/search-elasticsearch`.
  - **core:** README explains that `runWithContext` must await lazy thenables (Prisma queries) inside an async callback, otherwise they execute outside the context (`PRISMA_TENANT_MISSING`).
  - **testing:** README documents `withTenant` and lists the fakes that are not provided yet.
- Updated dependencies [b0cc59f]
- Updated dependencies [b0cc59f]
- Updated dependencies [b0cc59f]
- Updated dependencies [b0cc59f]
  - @basaltkit/core@1.3.2
  - @basaltkit/prisma@2.1.0
  - @basaltkit/scheduler@1.5.0
  - @basaltkit/storage@3.1.0

## 0.2.0

### Minor Changes

- fb85c40: Security hardening for PostgreSQL backups:
  
  - Database passwords are no longer passed to `pg_dump`/`pg_restore` on the command line; they are handed to the tool through `PGPASSWORD` (new `options.env` on `CommandRunner`, which custom runners must forward). Failure messages record only the tool name and exit code with credentials scrubbed, and a tenant `databaseUrl` is redacted before it is written to manifests or logs. Credentials are also scrubbed from extra error properties that loggers serialize (for example `cmd` on `execFile` errors and `input` on invalid-URL errors), and from non-`Error` string rejections.
  - `restore()` now verifies the manifest's canonical artifact path and the recorded SHA-256 checksum before running `pg_restore`, throwing the new `BackupIntegrityError` on mismatch. Retention pruning deletes only canonical artifact keys.

### Patch Changes

- Updated dependencies [fb85c40]
- Updated dependencies [fb85c40]
- Updated dependencies [fb85c40]
  - @basaltkit/prisma@2.0.0
  - @basaltkit/storage@3.0.0
  - @basaltkit/logger@1.3.0

## 0.1.0

### Minor Changes

- Initial PostgreSQL backup service with custom-format dumps, manifests,
  checksums, retention, restore confirmation, multi-tenant schema/database
  targets, Basalt storage integration, scheduler integration and CLI listing.