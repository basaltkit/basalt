<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/exports

Data export for Basalt: turns **typed** export definitions into **CSV / TSV / JSON / NDJSON** files (native, **zero dependencies**), through a formatter seam where XLSX/PDF plug in later. Large datasets can be **streamed** (`stream()`, CSV/TSV/JSON/NDJSON). Designed to run **asynchronously** with `@basaltkit/queue` and store the result with `@basaltkit/files`/`@basaltkit/storage`. You need this module when users export data or generate reports.

## What this module solves

Exporting well involves: mapping records to columns, escaping correctly (commas, quotes, line breaks), supporting multiple formats, and — for large volumes — running outside the request. This module gives you typed export definitions, native formatters with correct escaping (RFC 4180), and a seam for adding formats (XLSX, PDF) without changing the definitions.

## Installation

```bash
pnpm add @basaltkit/exports
```

Only depends on `@basaltkit/core`. The CSV/TSV/JSON/NDJSON formats need nothing else.

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { exportsPlugin, EXPORTS, defineExport } from '@basaltkit/exports'

const usersExport = defineExport<{ name: string; email: string; joinedAt: Date }>({
  name: 'users',
  columns: [
    { header: 'Name', value: (u) => u.name },
    { header: 'Email', value: (u) => u.email },
    { header: 'Joined', value: (u) => u.joinedAt },
  ],
})

const app = await createApp({ plugins: [exportsPlugin()] }).boot()
const exports = app.container.get(EXPORTS)

const result = await exports.run(usersExport, users, 'csv')
// { content: Buffer, contentType: 'text/csv', filename: 'users.csv', format, rowCount }
```

Dates become ISO; fields with commas/quotes/line breaks are quoted correctly.

## Large volumes: asynchronous via queue + storage

`run` is pure and returns the whole file as one `Buffer`. For large reports, run it inside a **job** and store the file:

```ts
const GenerateReport = defineJob<{ tenantId: string; requestedBy: string }>({
  name: 'reports.users', queue: 'reports',
  async handle({ tenantId, requestedBy }) {
    const rows = queryUsers(tenantId)                 // an array or an AsyncIterable
    const { content, filename, contentType } = await exports.run(usersExport, rows, 'csv')
    const file = await files.upload(content, { name: filename, contentType, tenantId, uploadedBy: requestedBy })
    await notifier.notify({ id: requestedBy }, ReportReady, { fileId: file.id }) // a defineNotification(...)
  },
})
```

`run` accepts an array **or** an `AsyncIterable`, but it **buffers**: every row is collected and the whole file is built in memory before it returns. That is fine for thousands of rows; for large datasets use `stream()`.

## Streaming large exports: `stream()`

`exports.stream(definition, data, format)` renders **incrementally**: rows are pulled from `data` (an array or an `AsyncIterable`, e.g. a cursor over the database) one at a time, and the file comes out as an `AsyncIterable<Buffer>` in chunks of about 64 KiB — memory stays bounded by one chunk, not by the dataset. The bytes are identical to `run()`'s `content`.

```ts
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const out = exports.stream(usersExport, queryUsers(tenantId), 'csv')
out.contentType // 'text/csv'   — known up front, for response headers
out.filename    // 'users.csv'

await pipeline(Readable.from(out), createWriteStream(`/tmp/${out.filename}`))
out.rowCount    // final once the stream has been consumed
```

It also works as a web `Response` body (`new Response(ReadableStream.from(out))`) or as the body of an S3 multipart upload. The stream is single-use.

| Format | `run()` | `stream()` |
|---|---|---|
| `csv`, `tsv`, `json`, `ndjson` | ✅ buffered | ✅ incremental |
| `xlsx` (`@basaltkit/exports-xlsx`), PDF and other formatters without `renderStream` | ✅ buffered | ❌ `ExportNotStreamableError` — the container format needs all the data up front |

`files.upload()` from `@basaltkit/files` accepts the stream directly, but note that it buffers the upload (up to its size limit) before writing to the disk — to keep memory flat end to end, pipe to a sink that streams (a file, an HTTP response, a multipart upload).

## Formats

| Format | Content-Type | Extension |
|---|---|---|
| `csv` | `text/csv` | `.csv` |
| `tsv` | `text/tab-separated-values` | `.tsv` |
| `json` | `application/json` | `.json` |
| `ndjson` | `application/x-ndjson` | `.ndjson` |

### Adding a format (XLSX, PDF…)

A formatter implements `render(headers, rows) → Buffer`, and optionally `renderStream(headers, rows: AsyncIterable<unknown[]>) → AsyncIterable<string | Buffer>` to support `stream()` (its concatenated output must equal `render()`'s). Bring your own library and register it:

```ts
const xlsx: ExportFormatter = {
  format: 'xlsx',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  extension: 'xlsx',
  render: (headers, rows) => buildXlsx(headers, rows), // with the library of your choice
}
exportsPlugin({ formatters: [xlsx] })
```

## API reference

| API | Description |
|---|---|
| `defineExport<T>({ name, columns })` | Defines a typed export; each column has `header` and `value(row)`. |
| `exportsPlugin({ formatters? })` | Registers the `EXPORTS` token with the native formats plus yours. |
| `EXPORTS` | DI token → the `Exports` service. |
| `exports.run(def, data, format)` | Renders the whole file in memory; returns `{ content: Buffer, contentType, filename, format, rowCount }`. `data` is an array or `AsyncIterable` (collected). |
| `exports.stream(def, data, format, { chunkSize? })` | Renders incrementally; returns an `ExportStream` — an `AsyncIterable<Buffer>` with `contentType`, `filename`, `format` and a live `rowCount`. `chunkSize` defaults to 64 KiB. Throws `ExportNotStreamableError` for formatters without `renderStream`. |
| `exports.formats()` | Available formats. |
| `exports.streamableFormats()` | Formats `stream()` accepts. |
| `UnknownExportFormatError` / `ExportNotStreamableError` | `EXPORT_UNKNOWN_FORMAT` / `EXPORT_NOT_STREAMABLE`, both HTTP 400. |
| `csvFormatter`, `tsvFormatter`, `jsonFormatter`, `ndjsonFormatter` | Native formatters. |

## How it connects to other modules

- **`@basaltkit/queue`** — runs large exports outside the request.
- **`@basaltkit/files` / `@basaltkit/storage`** — stores the generated file (with a signed URL for download).
- **`@basaltkit/notifications`** — notifies when the report is ready.
