<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/exports-xlsx

**XLSX** formatter for [`@basaltkit/exports`](https://www.npmjs.com/package/@basaltkit/exports): writes a valid `.xlsx` (Office Open XML) — **zero dependencies**. Bring your own Excel writer without dragging in heavy libraries. You need this module when users want to export to Excel, not just CSV.

## What this module solves

`.xlsx` is, at its core, a ZIP of XML files. Instead of relying on a large library (`exceljs`, `xlsx`), this package writes the ZIP (STORE method + CRC32) and the SpreadsheetML by hand — a single-sheet `.xlsx` file, with headers, strings, and numbers. It plugs into `@basaltkit/exports`'s *formatter* pipeline.

## Installation

```bash
pnpm add @basaltkit/exports-xlsx @basaltkit/exports
```

No runtime dependencies beyond `@basaltkit/exports` (only for the formatter type).

## Usage

Register the formatter with `@basaltkit/exports` and use the `'xlsx'` format:

```ts
import { exportsPlugin, defineExport } from '@basaltkit/exports'
import { xlsxFormatter } from '@basaltkit/exports-xlsx'

exportsPlugin({ formatters: [xlsxFormatter] })

const usersExport = defineExport<{ name: string; joinedAt: Date }>({
  name: 'users',
  columns: [
    { header: 'Name', value: (u) => u.name },
    { header: 'Joined', value: (u) => u.joinedAt },
  ],
})

const { content, filename, contentType } = await exports.run(usersExport, users, 'xlsx')
// content: Buffer (an .xlsx), filename: 'users.xlsx',
// contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
```

Or use the formatter directly:

```ts
const buffer = xlsxFormatter.render(['Name', 'Price'], [['Ada', 29], ['Bob', 0]])
```

### Dates, number formats, sheet name, frozen header

`createXlsxFormatter(options)` adds what an ERP or accountant expects from a real spreadsheet:

```ts
import { createXlsxFormatter } from '@basaltkit/exports-xlsx'

exportsPlugin({
  formatters: [createXlsxFormatter({ sheetName: 'Facturas', freezeHeader: true, dateFormat: 'dd/mm/yyyy', widths: [16] })],
})

defineExport<Invoice>({
  name: 'invoices',
  columns: [
    { header: 'Número', value: (i) => i.number },
    { header: 'Data', value: (i) => i.issuedAt, type: 'date' },
    { header: 'Total', value: (i) => i.total, format: '#,##0.00', width: 14 },
  ],
})
```

- `Date` values become **date cells** (Excel serial numbers from the UTC instant) styled with the column's `format` or `dateFormat` (default `yyyy-mm-dd`).
- Numbers in a column with a `format` get that number format (one `xl/styles.xml` style per distinct code).
- `widths` (by column index) or the columns' `width` hints become `<cols>`; `freezeHeader` freezes row 1.
- `sheetName` is validated (1–31 chars, none of `[ ] : * ? / \`, no leading/trailing `'`) and XML-escaped.

## Details

- With the plain `xlsxFormatter`, **numbers** become numeric cells; **dates** become ISO text (use `createXlsxFormatter` for date cells); everything else becomes an *inline string* (with XML escaping). `null`/`undefined` produce empty cells.
- One sheet (`Sheet1` unless `createXlsxFormatter({ sheetName })`). The ZIP uses the **STORE** method (no compression) — valid and opens fine in Excel/LibreOffice.
- **Buffer-only:** the whole workbook is built in memory (the ZIP needs each entry's size and CRC), so use `exports.run()`; `exports.stream()` rejects `xlsx` with `ExportNotStreamableError`.
- The produced `Buffer` passes `unzip -t` (correct CRCs) and opens in Excel/LibreOffice/Google Sheets.

## How it connects to other modules

- **`@basaltkit/exports`** — this is a *formatter* for that package; the export definition comes from there.
- **`@basaltkit/queue` + `@basaltkit/files`** — generate the `.xlsx` in a job and store it for download (large reports).
