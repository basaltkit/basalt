# Exportação de dados

`@basaltkit/exports` transforma definições de exportação tipadas em ficheiros — CSV,
TSV, JSON e NDJSON de raiz (zero dependências), com uma junção de formatador
plugável para XLSX/PDF. Foi feito para correr de forma assíncrona via
[`@basaltkit/queue`](/pt/guide/queues) e armazenar o resultado com `@basaltkit/files`.

[[toc]]

## Definir e correr

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

Regista o serviço com `exportsPlugin` e resolve-o sob o token `EXPORTS`:

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

CSV/TSV fazem quoting corretamente (RFC 4180), as datas renderizam como ISO, e
`run` aceita um array **ou** um `AsyncIterable`, para que as linhas possam vir em
stream da base de dados.

## Relatórios grandes: queue + storage

`run` é puro e síncrono por design. Para exportações grandes, corre-o dentro de um
job de [queue](/pt/guide/queues) e armazena o ficheiro com [`@basaltkit/files`](/pt/guide/files)
para download. `run` também aceita um `AsyncIterable`, para que as linhas venham em
stream diretamente da base de dados em vez de acumularem em memória:

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

Adiciona `@basaltkit/exports-xlsx` — um `.xlsx` válido com um **escritor ZIP
embutido**, ainda sem dependências:

```ts
import { xlsxFormatter } from '@basaltkit/exports-xlsx'
exportsPlugin({ formatters: [xlsxFormatter] })
await exports.run(usersExport, users, 'xlsx') // users.xlsx
```

Para adicionar outro formato (PDF, ODS…), implementa `ExportFormatter.render(headers,
rows) → Buffer` e regista-o da mesma forma — sem alterações à definição de
exportação.
