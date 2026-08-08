# @machize/exports

Data export for Machize: turns **typed** export definitions into **CSV / TSV / JSON / NDJSON** files (native, **zero dependencies**), through a formatter seam where XLSX/PDF plug in later. Designed to run **asynchronously** with `@machize/queue` and store the result with `@machize/files`/`@machize/storage`. You need this module when users export data or generate reports.

## What this module solves

Exporting well involves: mapping records to columns, escaping correctly (commas, quotes, line breaks), supporting multiple formats, and — for large volumes — running outside the request. This module gives you typed export definitions, native formatters with correct escaping (RFC 4180), and a seam for adding formats (XLSX, PDF) without changing the definitions.

## Installation

```bash
pnpm add @machize/exports
```

Only depends on `@machize/core`. The CSV/TSV/JSON/NDJSON formats need nothing else.

## Get started in 5 minutes

```ts
import { createApp } from '@machize/core'
import { exportsPlugin, EXPORTS, defineExport } from '@machize/exports'

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

`run` is synchronous and pure. For large reports, run it inside a **job** and store the file:

```ts
const GenerateReport = defineJob<{ tenantId: string; requestedBy: string }>({
  name: 'reports.users', queue: 'reports',
  async handle({ tenantId, requestedBy }) {
    const rows = queryUsers(tenantId)                 // an AsyncIterable also works
    const { content, filename, contentType } = await exports.run(usersExport, rows, 'csv')
    const file = await files.upload(content, { name: filename, contentType, tenantId, uploadedBy: requestedBy })
    await notifications.to(requestedBy).send('report.ready', { fileId: file.id })
  },
})
```

`run` accepts either an array **or** an `AsyncIterable`, so you can stream records from the database without loading them all into memory at once.

## Formats

| Format | Content-Type | Extension |
|---|---|---|
| `csv` | `text/csv` | `.csv` |
| `tsv` | `text/tab-separated-values` | `.tsv` |
| `json` | `application/json` | `.json` |
| `ndjson` | `application/x-ndjson` | `.ndjson` |

### Adding a format (XLSX, PDF…)

A formatter implements `render(headers, rows) → Buffer`. Bring your own library and register it:

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
| `exports.run(def, data, format)` | Renders; returns `{ content, contentType, filename, format, rowCount }`. |
| `exports.formats()` | Available formats. |
| `csvFormatter`, `tsvFormatter`, `jsonFormatter`, `ndjsonFormatter` | Native formatters. |

## How it connects to other modules

- **`@machize/queue`** — runs large exports outside the request.
- **`@machize/files` / `@machize/storage`** — stores the generated file (with a signed URL for download).
- **`@machize/notifications`** — notifies when the report is ready.
