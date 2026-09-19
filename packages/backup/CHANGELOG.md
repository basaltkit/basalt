# @basaltkit/backup

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