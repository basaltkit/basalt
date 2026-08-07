# @machize/exports-xlsx

Formatter **XLSX** para o [`@machize/exports`](https://www.npmjs.com/package/@machize/exports): escreve um `.xlsx` válido (Office Open XML) — **zero dependências**. Trás o teu próprio escritor de Excel sem arrastar bibliotecas pesadas. Precisas deste módulo quando os utilizadores querem exportar para Excel, não só CSV.

## O que este módulo resolve

O `.xlsx` é, no fundo, um ZIP de ficheiros XML. Em vez de depender de uma biblioteca grande (`exceljs`, `xlsx`), este pacote escreve o ZIP (método STORE + CRC32) e o SpreadsheetML à mão — um único ficheiro `.xlsx` de uma folha, com cabeçalhos, strings e números. Encaixa na costura de *formatters* do `@machize/exports`.

## Instalação

```bash
pnpm add @machize/exports-xlsx @machize/exports
```

Sem dependências de runtime além do `@machize/exports` (só para o tipo do formatter).

## Uso

Regista o formatter no `@machize/exports` e usa o formato `'xlsx'`:

```ts
import { exportsPlugin, defineExport } from '@machize/exports'
import { xlsxFormatter } from '@machize/exports-xlsx'

exportsPlugin({ formatters: [xlsxFormatter] })

const usersExport = defineExport<{ name: string; joinedAt: Date }>({
  name: 'users',
  columns: [
    { header: 'Nome', value: (u) => u.name },
    { header: 'Aderiu', value: (u) => u.joinedAt },
  ],
})

const { content, filename, contentType } = await exports.run(usersExport, users, 'xlsx')
// content: Buffer (um .xlsx), filename: 'users.xlsx',
// contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
```

Ou usa o formatter diretamente:

```ts
const buffer = xlsxFormatter.render(['Nome', 'Preço'], [['Ada', 29], ['Bob', 0]])
```

## Detalhes

- **Números** viram células numéricas; **datas** viram texto ISO; tudo o resto vira *inline string* (com escaping XML). Células vazias para `null`/`undefined`.
- Uma folha (`Sheet1`). O ZIP usa o método **STORE** (sem compressão) — legal e aberto por Excel/LibreOffice sem problema.
- O `Buffer` produzido passa `unzip -t` (CRCs corretos) e abre em Excel/LibreOffice/Google Sheets.

## Como se liga aos outros módulos

- **`@machize/exports`** — este é um *formatter* desse pacote; a definição do export vem de lá.
- **`@machize/queue` + `@machize/files`** — gera o `.xlsx` num job e guarda-o para download (relatórios grandes).
