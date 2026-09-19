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
`run` aceita um array **ou** um `AsyncIterable`. O `run` faz sempre **buffer** —
recolhe todas as linhas e devolve o ficheiro inteiro num único `Buffer`; para
grandes volumes de dados usa o [`stream()`](#exportacoes-grandes-em-stream).

As células CSV/TSV estão também protegidas contra **injeção de fórmulas**:
qualquer célula cujo texto final comece por `=`, `+`, `-`, `@` (ou as suas
formas de largura total `＝ ＋ － ＠`, também depois de espaços iniciais), um tab,
um carriage return ou um line feed recebe o prefixo `'`, para que a folha de
cálculo a mostre como texto em vez de a avaliar. A proteção aplica-se ao texto
final de todos os valores (strings, arrays, objetos, strings encapsuladas e
datas depois de renderizadas); só números, bigints e booleanos primitivos ficam
isentos, pelo que um número negativo continua numérico.

## Relatórios grandes: queue + storage

`run` é puro e devolve um único `Buffer`. Para exportações grandes, corre-o dentro de um
job de [queue](/pt/guide/queues) e armazena o ficheiro com [`@basaltkit/files`](/pt/guide/files)
para download (para volumes muito grandes, troca o `run` pelo [`stream()`](#exportacoes-grandes-em-stream)):

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

## Exportações grandes em stream

O `exports.stream(definition, data, format)` renderiza **incrementalmente**: as
linhas são lidas de `data` (um array ou um `AsyncIterable`, p.ex. um cursor da
base de dados) uma a uma e o ficheiro sai como um `AsyncIterable<Buffer>` em
blocos de ~64 KiB (`{ chunkSize }` para ajustar), por isso a memória fica limitada
a um bloco e não ao volume de dados. Os bytes são idênticos ao `content` do `run()`.

```ts
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const out = exports.stream(usersExport, queryUsers(tenantId), 'csv')
out.contentType // 'text/csv' — conhecido à partida, para os headers da resposta
out.filename    // 'users.csv'

await pipeline(Readable.from(out), createWriteStream(`/tmp/${out.filename}`))
out.rowCount    // final depois de o stream ser consumido
```

O stream só pode ser consumido uma vez; também serve como body de uma `Response`
web (`new Response(ReadableStream.from(out))`) ou de um upload multipart para S3.

| Formato | `run()` | `stream()` |
| --- | --- | --- |
| `csv`, `tsv`, `json`, `ndjson` | em buffer | incremental |
| `xlsx`, PDF, qualquer formatador sem `renderStream` | em buffer | `ExportNotStreamableError` (`EXPORT_NOT_STREAMABLE`, 400) |

O `exports.streamableFormats()` lista o que o `stream()` aceita.

::: warning Mantém o destino também em stream
O `files.upload()` aceita o stream, mas faz buffer do upload (até ao seu limite
de tamanho) antes de escrever no disco. Para manter a memória estável de ponta a
ponta, encaminha para um destino que faça stream — um ficheiro, uma resposta
HTTP, um upload multipart.
:::

## XLSX

Adiciona `@basaltkit/exports-xlsx` — um `.xlsx` válido com um **escritor ZIP
embutido**, ainda sem dependências:

```ts
import { xlsxFormatter } from '@basaltkit/exports-xlsx'
exportsPlugin({ formatters: [xlsxFormatter] })
await exports.run(usersExport, users, 'xlsx') // users.xlsx
```

O texto das células é escapado para XML, e os caracteres que o XML 1.0 proíbe
por completo (`0x00`–`0x08`, `0x0B`, `0x0C`, `0x0E`–`0x1F` — facilmente presentes
em dados vindos do utilizador) são escritos com o escape `_xHHHH_` do OOXML em
vez de passarem tal e qual, o que tornaria a folha impossível de ler e faria o
Excel recusar-se a abrir o ficheiro. Tab, newline e carriage return são XML
legal e ficam intactos.

O formatador XLSX funciona **só em buffer**: um `.xlsx` é um ZIP cujas entradas
precisam dos tamanhos e CRCs, por isso a folha inteira é construída em memória —
usa o `run()`, não o `stream()`.

Para adicionar outro formato (PDF, ODS…), implementa `ExportFormatter.render(headers,
rows) → Buffer` e regista-o da mesma forma — sem alterações à definição de
exportação. Implementa também o `renderStream(headers, rows: AsyncIterable<unknown[]>)
→ AsyncIterable<string | Buffer>` opcional (com bytes idênticos ao `render`) para
tornar o formato streamable.
