# @basaltkit/storage-s3

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
