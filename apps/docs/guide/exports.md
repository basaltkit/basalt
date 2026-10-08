# Data exports

`@basaltkit/exports` turns typed export definitions into files — CSV, TSV, JSON
and NDJSON out of the box (zero dependencies), with a pluggable formatter seam
for XLSX/PDF. It's built to run async via [`@basaltkit/queue`](/guide/queues) and
store the result with `@basaltkit/files`. It also reads CSV back:
[`defineImport`/`readImport`](#importing-csv) parse a file with strict locale
numbers and dates and a per-line error report.

[[toc]]

## Define and run

```ts
// src/exports/users.ts
import { defineExport } from '@basaltkit/exports'

export const usersExport = defineExport<{ name: string; email: string; joinedAt: Date }>({
  name: 'users',
  columns: [
    { header: 'Name', value: (u) => u.name },
    { header: 'Email', value: (u) => u.email },
    { header: 'Joined', value: (u) => u.joinedAt },
  ],
})
```

Register the service with `exportsPlugin` and resolve it under the `EXPORTS`
token:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { EXPORTS, exportsPlugin } from '@basaltkit/exports'
import { usersExport } from './exports/users.js'

export const app = await createApp({
  plugins: [exportsPlugin()],
}).boot()

const exports = app.container.get(EXPORTS)

const users = [{ name: 'Ada', email: 'ada@example.com', joinedAt: new Date() }]
const result = await exports.run(usersExport, users, 'csv')
// { content: Buffer, contentType: 'text/csv', filename: 'users.csv', format: 'csv', rowCount: 1 }
```

CSV/TSV quote correctly (RFC 4180), dates render as ISO (see
[pt locales](#exporting-for-excel-erp-in-pt-locales) for a BOM, `;` and
`1 408 278,55`), and `run` accepts an
array **or** an `AsyncIterable`. `run` always **buffers** — it collects every row
and returns the whole file as one `Buffer`; for large datasets use
[`stream()`](#streaming-large-exports).

CSV/TSV cells are also protected against **formula injection**: any cell whose
rendered text starts with `=`, `+`, `-`, `@` (or their full-width forms
`＝ ＋ － ＠`, also after leading whitespace), a tab, a carriage return or a line
feed is prefixed with `'`, so a spreadsheet shows it as text instead of
evaluating it. The guard applies to the final text of every value (strings,
arrays, objects, boxed strings, and dates after they are rendered); only
primitive numbers, bigints and booleans are exempt, so a negative number stays
numeric.

## Large reports: queue + storage

`run` is pure and returns one `Buffer`. For big exports, run it inside a
[queue](/guide/queues) job and store the file with [`@basaltkit/files`](/guide/files)
for download (for very large datasets, swap `run` for [`stream()`](#streaming-large-exports)):

```ts
// src/jobs/generate-report.ts
import { defineJob } from '@basaltkit/queue'
import { EXPORTS } from '@basaltkit/exports'
import { FILES } from '@basaltkit/files'
import { NOTIFIER, defineNotification } from '@basaltkit/notifications'
import { z } from 'zod'
import { app } from '../app.js'
import { usersExport } from '../exports/users.js'
import { queryUsers } from '../db.js' // returns an AsyncIterable<User>

const exports = app.container.get(EXPORTS)
const files = app.container.get(FILES)
const notifier = app.container.get(NOTIFIER)

const ReportReady = defineNotification({
  name: 'report.ready',
  schema: z.object({ fileId: z.string() }),
  channels: ['inApp'],
  via: { inApp: ({ fileId }) => ({ title: 'Your export is ready', data: { fileId } }) },
})

export const GenerateReport = defineJob<{ tenantId: string; requestedBy: string }>({
  name: 'reports.users',
  queue: 'reports',
  async handle({ tenantId, requestedBy }) {
    const { content, filename, contentType } = await exports.run(usersExport, queryUsers(tenantId), 'csv')
    const file = await files.upload(content, { name: filename, contentType, tenantId, uploadedBy: requestedBy })
    await notifier.notify({ id: requestedBy }, ReportReady, { fileId: file.id })
  },
})

// enqueue it from a route or command:
await GenerateReport.dispatch({ tenantId: 'acme', requestedBy: 'u1' })
```

## Streaming large exports

`exports.stream(definition, data, format)` renders **incrementally**: rows are
pulled from `data` (an array or an `AsyncIterable`, e.g. a database cursor) one
at a time and the file comes out as an `AsyncIterable<Buffer>` in ~64 KiB chunks
(`{ chunkSize }` to tune), so memory is bounded by one chunk rather than by the
dataset. The bytes are identical to `run()`'s `content`.

```ts
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const out = exports.stream(usersExport, queryUsers(tenantId), 'csv')
out.contentType // 'text/csv' — known up front, for response headers
out.filename    // 'users.csv'

await pipeline(Readable.from(out), createWriteStream(`/tmp/${out.filename}`))
out.rowCount    // final once the stream is consumed
```

The stream is single-use; it also works as a web `Response` body
(`new Response(ReadableStream.from(out))`) or an S3 multipart upload body.

| Format | `run()` | `stream()` |
| --- | --- | --- |
| `csv`, `tsv`, `json`, `ndjson` | buffered | incremental |
| `xlsx`, PDF, any formatter without `renderStream` | buffered | `ExportNotStreamableError` (`EXPORT_NOT_STREAMABLE`, 400) |

`exports.streamableFormats()` lists what `stream()` accepts.

::: warning Keep the sink streaming too
`files.upload()` accepts the stream, but it buffers the upload (up to its size
limit) before writing to the disk. To keep memory flat end to end, pipe into a
sink that streams — a file, an HTTP response, a multipart upload.
:::

## XLSX

Add `@basaltkit/exports-xlsx` — a valid `.xlsx` with a **built-in ZIP writer**,
still zero-dependency:

```ts
import { xlsxFormatter } from '@basaltkit/exports-xlsx'
exportsPlugin({ formatters: [xlsxFormatter] })
await exports.run(usersExport, users, 'xlsx') // users.xlsx
```

Cell text is XML-escaped, and characters XML 1.0 forbids outright (`0x00`–`0x08`,
`0x0B`, `0x0C`, `0x0E`–`0x1F` — easily present in user-supplied data) are written
with OOXML's `_xHHHH_` escape rather than passed through, which would make the
sheet unparseable and Excel refuse to open it. Tab, newline and carriage return
are legal XML and stay verbatim.

The XLSX formatter is **buffer-only**: a `.xlsx` is a ZIP whose entries need
their sizes and CRCs, so the whole sheet is built in memory — use `run()`, not
`stream()`.

To add another format (PDF, ODS…), implement `ExportFormatter.render(headers,
rows, columns?) → Buffer` and register it the same way — no export definition changes.
Implement the optional `renderStream(headers, rows: AsyncIterable<unknown[]>,
columns?) → AsyncIterable<string | Buffer>` as well (byte-identical to `render`)
to make the format streamable. `columns` carries each column's `header` plus its
optional `type`, `format` and `width` hints; a formatter may ignore it.

## Exporting for Excel/ERP in pt locales

A file that a spreadsheet or ERP in a Portuguese-speaking locale opens without
retouching needs three things the defaults don't do: a UTF-8 BOM (or Excel on
Windows reads `Número` as `NÃºmero`), `;` as the delimiter, and numbers/dates
written the local way (`1 408 278,55`, `14/03/2026`). `createCsvFormatter` does
all three:

```ts
import { createCsvFormatter, exportsPlugin } from '@basaltkit/exports'

const ptCsv = createCsvFormatter({
  delimiter: ';',
  bom: true,
  locale: { decimal: ',', thousands: ' ', date: 'dd/mm/yyyy' },
})

exportsPlugin({ formatters: [ptCsv] }) // registers as 'csv', replacing the default
// 1408278.55 → 1 408 278,55 · -1408278.55 → -1 408 278,55 · Date → 14/03/2026
```

Pass **numbers and `Date`s, not pre-formatted strings**: the locale only changes
how a primitive number is spelled *after* the formula-injection guard has exempted
it, so a credit note's `-1 408 278,55` stays a number, while a string such as
`'-1408278,55'` is still guarded (`'-1408278,55`) — the guard is not
configurable. `'dd/mm/yyyy'` uses the UTC calendar day; pass a function
(`date: (d) => …`) for anything else. `format: 'csv-pt'` registers it next to the
default instead of replacing it. `stream()` emits the same bytes, BOM included.

For XLSX, `createXlsxFormatter` writes **real date cells** (Excel serial numbers
with a date format, from the UTC instant; a date before 1900-03-01, which Excel
serials cannot represent correctly, stays ISO text) and applies per-column number formats,
widths, a sheet name and a frozen header. The hints live on the export
definition:

```ts
import { createXlsxFormatter } from '@basaltkit/exports-xlsx'

const invoicesExport = defineExport<Invoice>({
  name: 'invoices',
  columns: [
    { header: 'Número', value: (i) => i.number, width: 16 },
    { header: 'Data', value: (i) => i.issuedAt, type: 'date' },
    { header: 'Total', value: (i) => i.total, type: 'number', format: '#,##0.00', width: 14 },
  ],
})

exportsPlugin({
  formatters: [ptCsv, createXlsxFormatter({ sheetName: 'Facturas', freezeHeader: true, dateFormat: 'dd/mm/yyyy' })],
})
```

| `createXlsxFormatter` option | Default | Effect |
| --- | --- | --- |
| `sheetName` | `'Sheet1'` | Worksheet name; 1–31 chars, none of `[ ] : * ? / \`, not starting/ending with `'` (throws `TypeError` otherwise) |
| `freezeHeader` | `false` | Keeps the header row visible while scrolling |
| `dateFormat` | `'yyyy-mm-dd'` | Number format of date cells whose column has no `format` |
| `widths` | — | Column widths by index; override the columns' `width` |
| `format` | `'xlsx'` | Format name it registers under |

The plain `xlsxFormatter` is unchanged (dates as ISO text, no styles). Number
formats are display formats: the cell still holds the raw number, so Excel shows
it with the viewer's own decimal separator.

## Importing CSV

The reverse path — reading what an ERP or spreadsheet exports — ships in the
same package. `defineImport` declares the columns once; `readImport` reads a
file (a `string`, a `Uint8Array` or an `AsyncIterable` of chunks, e.g. an upload
stream) and returns the parsed rows plus a per-line error report for a preview
screen. It **never throws on bad data**.

```ts
import { defineImport, readImport } from '@basaltkit/exports'

const purchaseOrders = defineImport<{ number: string; quantity: number; unitPrice: number; dueDate: Date | null }>({
  name: 'purchase-orders',
  delimiter: ';',
  locale: { decimal: ',', thousands: ' ', date: 'dd/mm/yyyy' },
  maxRows: 2000,
  columns: [
    { key: 'number', headers: ['Número', 'Nº'], required: true },
    { key: 'quantity', headers: ['Quantidade', 'Qtd'], required: true, parse: 'integer' },
    { key: 'unitPrice', headers: ['Preço unitário'], required: true, parse: 'decimal' },
    { key: 'dueDate', headers: ['Data de entrega'], parse: 'date' },
  ],
})

const { rows, errors, warnings } = await readImport(purchaseOrders, file)
// rows:   [{ line: 2, value: { number: 'PO-1', quantity: 1000, unitPrice: 1250.5, dueDate: Date } }, …]
// errors: [{ line: 7, column: 'unitPrice', code: 'AMBIGUOUS_DECIMAL', message: '"12.5" is ambiguous: …' }]
```

- **Headers by name**, in any order, with synonyms; matching ignores case,
  accents and repeated whitespace (`PREÇO  UNITÁRIO` matches `Preço unitário`).
  A missing `required` column or two headers mapping to one column fail the
  file; an unknown header is a warning (`unknownColumns: 'error'` to reject it).
- **Strict numbers.** The separator that is not the decimal one is accepted
  only as a thousands separator in groups of three. With a comma decimal,
  `1.250,50` is 1250.5 and `1 408 278,55` is 1408278.55, but `12.5` is
  `AMBIGUOUS_DECIMAL` — never silently read as 125 or 12.5, which is how a
  price ends up off by a factor of 1 000. A group never starts with `0`
  (`0.250` is ambiguous too, not 250). `'integer'` refuses a fraction.
- **Dates** are `'dd/mm/yyyy'` or ISO (`yyyy-mm-dd`, or a timestamp with an
  offset), validated against the calendar (`31/02/2026` is `INVALID_DATE`),
  and come back as UTC midnight. For anything else pass a function as `parse`;
  a throw becomes `INVALID_VALUE` with its message.
- **Per-row errors.** Cells are trimmed; an empty optional cell is `null`, an
  empty required cell is `REQUIRED`. A row with any error, or the wrong number of
  fields (`COLUMN_COUNT`), is left out of `rows`, and each bad cell gets its own
  `{ line, column, code, message }` — `line` is the physical line of the file,
  counted across line breaks inside quoted fields. `maxErrors` (default 1 000)
  caps the report.
- **Fails closed on a malformed file.** An unterminated quote, text after a
  closing quote, a quote inside an unquoted field, invalid UTF-8, a field longer
  than `maxFieldLength`, or more than `maxRows` data rows (default 10 000,
  checked while streaming, before the rest is read) returns that single error
  and **no rows** — a truncated file is never half-imported.

The low-level reader is exported too: `parseDelimited(input, { delimiter,
quote, bom, maxRows, maxFieldLength })` is an RFC 4180 async iterator of
`{ line, cells }` that throws `DelimitedParseError` (`code`
`CSV_UNTERMINATED_QUOTE`, …, with `reason` and `line`). A leading BOM is
stripped (`bom: 'forbid'` rejects it). What `createCsvFormatter` writes reads
back with the same `delimiter` and `locale`: numbers and dates parse to the same
values, while text the formula guard prefixed keeps its leading `'`.
