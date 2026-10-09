# @basaltkit/exports

## 1.3.0

### Minor Changes

- b26c9b4: CSV import (BK-086): `parseDelimited(input, { delimiter, quote, bom, maxRows, maxFieldLength })` is a strict RFC 4180 async iterator of `{ line, cells }` over a string, bytes or an async iterable of chunks, with physical line numbers across quoted line breaks; malformed input throws `DelimitedParseError` (`CSV_UNTERMINATED_QUOTE`, `CSV_INVALID_QUOTE`, `CSV_TOO_MANY_ROWS`, `CSV_FIELD_TOO_LARGE`, `CSV_BOM_FORBIDDEN`, `CSV_INVALID_ENCODING`), with limits enforced while streaming. `defineImport` + `readImport` map headers by folded name (case, accents, whitespace; synonyms), parse `'text' | 'integer' | 'decimal' | 'date' | fn` with the shared `LocaleSpec` — strict decimals (`'12.5'` with a comma decimal is `AMBIGUOUS_DECIMAL`, `'1.250,50'` is 1250.5) and calendar-validated dates — and return `{ rows, errors, warnings }` with `{ line, column, code, message }` issues, never throwing on bad data and returning no rows for a malformed file.
- b2de3d9: CSV for Excel/ERP in non-English locales (BK-081): `createCsvFormatter({ delimiter, bom, locale, format })` adds a UTF-8 BOM and `LocaleSpec` number/date rendering (`1408278.55` → `1 408 278,55`, dates → `14/03/2026`). The locale only re-spells primitive numbers and Dates after the formula-injection guard decides, so the guard is unchanged and fail-closed. `DelimitedFormatter` takes an optional fifth `{ bom, locale }` argument. `ExportColumn` gains optional `type`, `format` and `width` hints, passed to formatters as a third `columns: ExportColumnMeta[]` argument of `render`/`renderStream` (existing formatters ignore it). Native formatters' output is unchanged.

### Patch Changes

- Updated dependencies [7a3fd88]
  - @basaltkit/core@1.6.0

## 1.2.0

### Minor Changes

- b0cc59f: Close documentation drift where the docs promised more than the code delivered.
  
  - **exports:** new `exports.stream(definition, data, format, { chunkSize? })` renders CSV/TSV/JSON/NDJSON incrementally — rows are pulled one at a time from an array or `AsyncIterable` and the file is emitted as an `AsyncIterable<Buffer>` in ~64 KiB chunks (byte-identical to `run()`), so memory stays bounded for large datasets. Formatters opt in with the new optional `ExportFormatter.renderStream()`; buffer-only formatters (XLSX, PDF) are rejected with `ExportNotStreamableError` (`EXPORT_NOT_STREAMABLE`, 400). Adds `exports.streamableFormats()`. The README no longer claims that `run()` avoids loading everything into memory: it buffers by design.
  - **exports-xlsx:** README states that the XLSX formatter is buffer-only.
  - **backup:** README no longer calls dump artifacts "immutable" (they are plain `disk.put()` writes); documents how to get immutability with bucket versioning + S3 Object Lock as the application's responsibility.
  - **comments:** README mention-notification example uses the real `notifier.notify(recipient, definition, data)` API instead of a non-existent `notifications.to(...).send(...)`.
  - **search:** README documents every driver — including `@basaltkit/search-postgres` and `@basaltkit/search-elasticsearch`.
  - **core:** README explains that `runWithContext` must await lazy thenables (Prisma queries) inside an async callback, otherwise they execute outside the context (`PRISMA_TENANT_MISSING`).
  - **testing:** README documents `withTenant` and lists the fakes that are not provided yet.

### Patch Changes

- Updated dependencies [b0cc59f]
  - @basaltkit/core@1.3.2

## 1.1.3

### Patch Changes

- fb85c40: security(exports): the CSV/TSV formula-injection guard now checks the final rendered text of every value except primitive numbers, bigints and booleans — arrays, objects, boxed strings and dates (after rendering) included — and also neutralises a leading line feed, the full-width `＝ ＋ － ＠` forms and triggers preceded by whitespace.

## 1.1.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.1.0

### Minor Changes

- Security: **CSV/TSV export neutralizes spreadsheet formula injection.** A string cell beginning with `=`, `+`, `-`, `@`, or a leading tab/CR is a formula a spreadsheet evaluates on open — so an exported value like `=WEBSERVICE(...)` could exfiltrate data or run a command on the recipient's machine. Such string cells are now prefixed with a single quote so the spreadsheet renders them as text. Numbers and dates are untouched (a negative number stays `-5`).

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

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Minor Changes

- 09a5fd6: New package: `@basaltkit/exports` — data exports and reporting.

  `defineExport<T>({ name, columns })` declares a typed export (each column has a `header` and a `value(row)`), and `Exports.run(def, data, format)` renders it to a file, returning `{ content, contentType, filename, format, rowCount }`. Native formatters — `csv`, `tsv` (RFC-4180 quoting, CRLF, ISO dates), `json`, `ndjson` — need no dependencies; a pluggable `ExportFormatter` seam lets XLSX/PDF drivers register via `exportsPlugin({ formatters })`. `run` accepts an array or an `AsyncIterable`, so rows can be streamed from the database, and it's pure/synchronous by design — run it inside a `@basaltkit/queue` job and store the result with `@basaltkit/files`/`@basaltkit/storage` for large reports. Fully unit-tested — escaping, every native format, async iterables, custom formatters, and the plugin.

### Patch Changes

- @basaltkit/core@0.15.0
