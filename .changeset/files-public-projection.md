---
'@basaltkit/files': major
---

`fileRoutes()` answers with a public projection of the record, and `upload()` holds `contentLength` to its word (audit, improvements item 7).

**Breaking — routes no longer return the raw `FileRecord`.** `GET /files`, `GET /files/:id` and `POST /files` returned every field, including the storage `path` (the bucket layout), the `checksum`, `tenantId`, `uploadedBy` (someone else's user id on a shared drive) and the scanner's `metadata.scan.detail` (engine output). They now answer with `toPublicFile(record)`: `{ id, name, contentType, size, createdAt, scannedAt?, scan?: { clean }, metadata? }` — the verdict stays, the detail and the internal `scan` metadata entry do not. New option `fileRoutes({ present: (record, user) => unknown })` chooses the shape; new exports `toPublicFile` and `PublicFileRecord`.

Migration: a client that read any of those fields from the routes needs a `present` that adds them back, e.g. `present: (file) => ({ ...toPublicFile(file), uploadedBy: file.uploadedBy })`. `files.get()`, `files.list()` and the `file:*` hooks are unchanged and still return the full record server-side. A custom upload route that sent the record should send `toPublicFile(record)` too.

**`upload({ contentLength })` is validated and verified.** It used to be a hint. Now a value that is not a non-negative safe integer is refused before the body is read (`400 STORAGE_CONTENT_LENGTH_INVALID`), one above `validate.maxSize` answers `413 FILE_TOO_LARGE` up front, and a body with a different byte count fails with `400 STORAGE_CONTENT_LENGTH_MISMATCH` on both the streaming and the buffered path — leaving neither an object nor a record. Never pass a multipart request's own `Content-Length` as a file's `contentLength` (it includes the framing).
