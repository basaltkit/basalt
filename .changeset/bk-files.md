---
'@basaltkit/files': minor
---

Content sniffing, scan quarantine and streaming uploads (BK-003, BK-004, BK-006).

- `validate.sniff: true | ((bytes: Uint8Array) => string | null)` (opt-in, default off — consider enabling it): the real type is read from the magic bytes by a built-in, dependency-free signature table (PDF, PNG, JPEG, GIF, WebP, TIFF both byte orders, ZIP, docx/xlsx/pptx, plus HTML/SVG/XML text and PE/ELF/Mach-O/`#!` executables to catch disguises). Content that contradicts the declared type — or a declared signature type whose bytes don't carry it (renamed/truncated files) — is refused with `FileTypeMismatchError` (`415 FILE_TYPE_MISMATCH`). `allowedTypes` then judges the detected type, `FileRecord.contentType` is the detected type, and the client's claim is kept in `metadata.declaredType`. `sniffContentType` and `normalizeContentType` are exported.
- `requireScan: true` (on `filesPlugin` / `Files`, default off): `download()` and `temporaryUrl()` — and so `POST /files/:id/url` on every adapter — throw `FileNotScannedError` (`423 FILE_NOT_SCANNED`) until `markScanned` reports the file clean, and `FileInfectedError` (`403 FILE_INFECTED`) after a failed scan. A scan timestamp without a clean verdict fails closed. Listing is unaffected. The scanner reads quarantined bytes with `download(id, tenantId, { bypassQuarantine: true })`.
- `upload()` accepts a stream — Node `Readable`, `AsyncIterable<Uint8Array>` or web `ReadableStream` — besides a `Buffer`/`Uint8Array`. `maxSize` is enforced while the stream arrives (the source is destroyed/cancelled past the cap, nothing is written), the size and SHA-256 are computed on the fly, and sniffing runs on the first 64 KiB. Since the storage `Disk.put` contract takes whole buffers, accepted bytes (at most `maxSize`) are buffered before the write.
- `markScanned` now stamps `scannedAt` with the injectable `now` clock instead of `Date.now()`.
