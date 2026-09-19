# Data exports

`@basaltkit/exports` turns typed export definitions into files — CSV, TSV, JSON
and NDJSON out of the box (zero dependencies), with a pluggable formatter seam
for XLSX/PDF. It's built to run async via [`@basaltkit/queue`](/guide/queues) and
store the result with `@basaltkit/files`.

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

CSV/TSV quote correctly (RFC 4180), dates render as ISO, and `run` accepts an
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
rows) → Buffer` and register it the same way — no export definition changes.
Implement the optional `renderStream(headers, rows: AsyncIterable<unknown[]>)
→ AsyncIterable<string | Buffer>` as well (byte-identical to `render`) to make
the format streamable.
