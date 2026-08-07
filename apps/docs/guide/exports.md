# Data exports

`@machize/exports` turns typed export definitions into files — CSV, TSV, JSON
and NDJSON out of the box (zero dependencies), with a pluggable formatter seam
for XLSX/PDF. It's built to run async via [`@machize/queue`](/guide/queues) and
store the result with `@machize/files`.

## Define and run

```ts
import { exportsPlugin, EXPORTS, defineExport } from '@machize/exports'

const usersExport = defineExport<{ name: string; email: string; joinedAt: Date }>({
  name: 'users',
  columns: [
    { header: 'Name', value: (u) => u.name },
    { header: 'Email', value: (u) => u.email },
    { header: 'Joined', value: (u) => u.joinedAt },
  ],
})

exportsPlugin()
const exports = app.container.get(EXPORTS)

const result = await exports.run(usersExport, users, 'csv')
// { content: Buffer, contentType, filename: 'users.csv', format, rowCount }
```

CSV/TSV quote correctly (RFC 4180), dates render as ISO, and `run` accepts an
array **or** an `AsyncIterable`, so rows can be streamed from the database.

## Large reports: queue + storage

`run` is pure and synchronous by design. For big exports, run it inside a job
and store the file for download:

```ts
const GenerateReport = defineJob({
  name: 'reports.users', queue: 'reports',
  async handle({ tenantId, requestedBy }) {
    const { content, filename, contentType } = await exports.run(usersExport, queryUsers(tenantId), 'csv')
    const file = await files.upload(content, { name: filename, contentType, tenantId, uploadedBy: requestedBy })
    await notifications.to(requestedBy).send('report.ready', { fileId: file.id })
  },
})
```

## XLSX

Add `@machize/exports-xlsx` — a valid `.xlsx` with a **built-in ZIP writer**,
still zero-dependency:

```ts
import { xlsxFormatter } from '@machize/exports-xlsx'
exportsPlugin({ formatters: [xlsxFormatter] })
await exports.run(usersExport, users, 'xlsx') // users.xlsx
```

To add another format (PDF, ODS…), implement `ExportFormatter.render(headers,
rows) → Buffer` and register it the same way — no export definition changes.
