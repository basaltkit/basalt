---
'@basaltkit/storage': minor
'@basaltkit/storage-s3': minor
'@basaltkit/storage-azure': minor
'@basaltkit/storage-gcs': minor
---

Pre-signed direct uploads and an `s3Disk` security fix.

- **fix (storage-s3, BK-015):** `s3Disk({...})` forwarded only `scope` to the disk and silently dropped every other `DiskOptions` field — `onMissingScope` and `maxTemporaryUrlTtl` were lost without error. It now splits driver options from disk options by the driver's own key list, so every disk option (current and future) reaches the `Disk`.
- **feat (storage, BK-005):** optional driver capability `temporaryUploadUrl(path, expiresInMs, { contentType, contentLength?, checksumSha256? })`, exposed as `disk.temporaryUploadUrl(key, { expiresIn, contentType, contentLength?, checksumSha256?, maxBytes?, allowedContentTypes? })` returning `{ url, method: 'PUT', headers, expiresAt, key }`. Same safety rules as `temporaryUrl`: key validation, tenant prefix, fail-closed without a tenant, and a lifetime cap via the new `maxTemporaryUploadUrlTtl` disk option (default 1 hour, or `maxTemporaryUrlTtl` when lower). `contentType` is required. New errors `TemporaryUploadUrlUnsupportedError` (`STORAGE_UPLOAD_URL_UNSUPPORTED`) and `StorageUploadUrlInvalidError` (`400 STORAGE_UPLOAD_URL_INVALID`); new export `DEFAULT_MAX_TEMPORARY_UPLOAD_URL_TTL`.
- **feat (storage-s3):** presigned `PutObject` with Content-Type, Content-Length, `x-amz-checksum-sha256` and SSE headers signed as headers (not hoisted), presigned without the SDK's default empty-body CRC32 checksum. New `serverSideEncryption: 'AES256' | { kms }` driver option applied to every put and every presigned upload.
- **feat (storage-azure):** create/write-only SAS upload URL (header binding is not possible on Azure — documented); `checksumSha256` refused.
- **feat (storage-gcs):** V4 signed `write` URL binding Content-Type and `x-goog-content-length-range`; `checksumSha256` refused. `GcsFileLike.getSignedUrl` now takes the exported `GcsSignedUrlConfig`.
