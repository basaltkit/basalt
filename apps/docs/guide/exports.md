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
array **or** an `AsyncIterable`, so rows can be streamed from the database.

## Large reports: queue + storage

`run` is pure and synchronous by design. For big exports, run it inside a
[queue](/guide/queues) job and store the file with [`@basaltkit/files`](/guide/files)
for download. `run` also accepts an `AsyncIterable`, so rows stream straight from
the database instead of buffering in memory:

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

## XLSX

Add `@basaltkit/exports-xlsx` — a valid `.xlsx` with a **built-in ZIP writer**,
still zero-dependency:

```ts
import { xlsxFormatter } from '@basaltkit/exports-xlsx'
exportsPlugin({ formatters: [xlsxFormatter] })
await exports.run(usersExport, users, 'xlsx') // users.xlsx
```

To add another format (PDF, ODS…), implement `ExportFormatter.render(headers,
rows) → Buffer` and register it the same way — no export definition changes.
