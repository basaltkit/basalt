# @machize/exports

Exportação de dados para o Machize: transforma definições de export **tipadas** em ficheiros **CSV / TSV / JSON / NDJSON** (nativo, **zero dependências**), através de uma costura de *formatters* onde XLSX/PDF se ligam depois. Pensado para correr **assíncrono** com o `@machize/queue` e guardar o resultado com o `@machize/files`/`@machize/storage`. Precisas deste módulo quando os utilizadores exportam dados ou geram relatórios.

## O que este módulo resolve

Exportar bem envolve: mapear registos para colunas, escapar corretamente (vírgulas, aspas, quebras de linha), suportar vários formatos, e — para grandes volumes — correr fora do pedido. Este módulo dá-te definições de export tipadas, formatters nativos com escaping correto (RFC 4180), e uma costura para adicionar formatos (XLSX, PDF) sem mudar as definições.

## Instalação

```bash
pnpm add @machize/exports
```

Depende apenas do `@machize/core`. Os formatos CSV/TSV/JSON/NDJSON não precisam de nada.

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { exportsPlugin, EXPORTS, defineExport } from '@machize/exports'

const usersExport = defineExport<{ name: string; email: string; joinedAt: Date }>({
  name: 'users',
  columns: [
    { header: 'Nome', value: (u) => u.name },
    { header: 'Email', value: (u) => u.email },
    { header: 'Aderiu', value: (u) => u.joinedAt },
  ],
})

const app = await createApp({ plugins: [exportsPlugin()] }).boot()
const exports = app.container.get(EXPORTS)

const result = await exports.run(usersExport, users, 'csv')
// { content: Buffer, contentType: 'text/csv', filename: 'users.csv', format, rowCount }
```

As datas viram ISO; os campos com vírgula/aspas/quebras são citados corretamente.

## Grandes volumes: assíncrono via queue + storage

`run` é síncrono e puro. Para relatórios grandes, corre-o num **job** e guarda o ficheiro:

```ts
const GenerateReport = defineJob<{ tenantId: string; requestedBy: string }>({
  name: 'reports.users', queue: 'reports',
  async handle({ tenantId, requestedBy }) {
    const rows = queryUsers(tenantId)                 // uma AsyncIterable também serve
    const { content, filename, contentType } = await exports.run(usersExport, rows, 'csv')
    const file = await files.upload(content, { name: filename, contentType, tenantId, uploadedBy: requestedBy })
    await notifications.to(requestedBy).send('report.ready', { fileId: file.id })
  },
})
```

`run` aceita um array **ou** uma `AsyncIterable`, por isso podes fazer *stream* dos registos da base de dados sem os carregar todos em memória de uma vez.

## Formatos

| Formato | Content-Type | Extensão |
|---|---|---|
| `csv` | `text/csv` | `.csv` |
| `tsv` | `text/tab-separated-values` | `.tsv` |
| `json` | `application/json` | `.json` |
| `ndjson` | `application/x-ndjson` | `.ndjson` |

### Adicionar um formato (XLSX, PDF…)

Um formatter implementa `render(headers, rows) → Buffer`. Traz a tua biblioteca e regista-o:

```ts
const xlsx: ExportFormatter = {
  format: 'xlsx',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  extension: 'xlsx',
  render: (headers, rows) => buildXlsx(headers, rows), // com a lib à tua escolha
}
exportsPlugin({ formatters: [xlsx] })
```

## Referência da API

| API | Descrição |
|---|---|
| `defineExport<T>({ name, columns })` | Define um export tipado; cada coluna tem `header` e `value(row)`. |
| `exportsPlugin({ formatters? })` | Regista o token `EXPORTS` com os formatos nativos + os teus. |
| `EXPORTS` | Token DI → o serviço `Exports`. |
| `exports.run(def, data, format)` | Renderiza; devolve `{ content, contentType, filename, format, rowCount }`. |
| `exports.formats()` | Formatos disponíveis. |
| `csvFormatter`, `tsvFormatter`, `jsonFormatter`, `ndjsonFormatter` | Formatters nativos. |

## Como se liga aos outros módulos

- **`@machize/queue`** — corre exports grandes fora do pedido.
- **`@machize/files` / `@machize/storage`** — guarda o ficheiro gerado (com URL assinado para download).
- **`@machize/notifications`** — avisa quando o relatório está pronto.
