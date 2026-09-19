---
'@basaltkit/exports': minor
'@basaltkit/exports-xlsx': patch
'@basaltkit/backup': patch
'@basaltkit/comments': patch
'@basaltkit/search': patch
'@basaltkit/core': patch
'@basaltkit/testing': patch
---

Close documentation drift where the docs promised more than the code delivered.

- **exports:** new `exports.stream(definition, data, format, { chunkSize? })` renders CSV/TSV/JSON/NDJSON incrementally — rows are pulled one at a time from an array or `AsyncIterable` and the file is emitted as an `AsyncIterable<Buffer>` in ~64 KiB chunks (byte-identical to `run()`), so memory stays bounded for large datasets. Formatters opt in with the new optional `ExportFormatter.renderStream()`; buffer-only formatters (XLSX, PDF) are rejected with `ExportNotStreamableError` (`EXPORT_NOT_STREAMABLE`, 400). Adds `exports.streamableFormats()`. The README no longer claims that `run()` avoids loading everything into memory: it buffers by design.
- **exports-xlsx:** README states that the XLSX formatter is buffer-only.
- **backup:** README no longer calls dump artifacts "immutable" (they are plain `disk.put()` writes); documents how to get immutability with bucket versioning + S3 Object Lock as the application's responsibility.
- **comments:** README mention-notification example uses the real `notifier.notify(recipient, definition, data)` API instead of a non-existent `notifications.to(...).send(...)`.
- **search:** README documents every driver — including `@basaltkit/search-postgres` and `@basaltkit/search-elasticsearch`.
- **core:** README explains that `runWithContext` must await lazy thenables (Prisma queries) inside an async callback, otherwise they execute outside the context (`PRISMA_TENANT_MISSING`).
- **testing:** README documents `withTenant` and lists the fakes that are not provided yet.
