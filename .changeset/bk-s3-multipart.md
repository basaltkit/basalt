---
'@basaltkit/storage-s3': minor
---

Multipart upload for streams of unknown length, as an optional capability (BK-021).

`putStream` could only reach S3 when the body's size was known: with a `contentLength` it streamed straight into `PutObject`, with a `maxBytes` cap it buffered up to that cap, and with neither it threw `STORAGE_STREAM_LENGTH_REQUIRED` — leaving the app to drop down to the raw AWS SDK. It now uploads such a body **multipart** (`CreateMultipartUpload` → `UploadPart`… → `CompleteMultipartUpload`), so a stream of any size goes through while only `partSizeBytes × queueSize` bytes are ever in memory.

- **`@aws-sdk/lib-storage` is an optional peer dependency** (`peerDependenciesMeta: { optional: true }`), never imported at module load: it is resolved with a cached dynamic `import()` inside the one code path that needs it. An app that does not install it is unaffected, and there `putStream` with neither option still throws `STORAGE_STREAM_LENGTH_REQUIRED` — with the message extended to name the package that would allow it. A load failure that is *not* "package missing" (a broken install) surfaces instead of being downgraded into that error.
- **Nothing else changes.** A declared `contentLength` still streams straight into `PutObject`; a `maxBytes` cap still buffers up to it and sends one object, and is still enforced mid-stream by the facade's limited `Readable` — the multipart path is taken only when neither is given.
- New driver options, also accepted per `putStream` call (`S3PutStreamOptions`): `partSizeBytes` (default `5 MiB`, exported as `S3_MIN_PART_SIZE_BYTES` and validated as the floor S3 imposes on every part but the last) and `queueSize` (parts in parallel, default `4`). Both are validated when the driver is constructed, so a misconfigured disk fails at boot; `s3Disk()` forwards them like every other driver option.
- A multipart object carries the same tenant-scoped `Key`, `ContentType` and `serverSideEncryption` (SSE-S3 or SSE-KMS) a single-shot `PutObject` would.
- **Failures abort the upload** and destroy the source, so S3 is left with no incomplete parts — which are invisible in listings and billed until removed. The README and the storage guide document the `AbortIncompleteMultipartUpload` lifecycle rule as the belt-and-braces.
