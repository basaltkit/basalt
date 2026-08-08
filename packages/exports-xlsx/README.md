# @machize/exports-xlsx

**XLSX** formatter for [`@machize/exports`](https://www.npmjs.com/package/@machize/exports): writes a valid `.xlsx` (Office Open XML) — **zero dependencies**. Bring your own Excel writer without dragging in heavy libraries. You need this module when users want to export to Excel, not just CSV.

## What this module solves

`.xlsx` is, at its core, a ZIP of XML files. Instead of relying on a large library (`exceljs`, `xlsx`), this package writes the ZIP (STORE method + CRC32) and the SpreadsheetML by hand — a single-sheet `.xlsx` file, with headers, strings, and numbers. It plugs into `@machize/exports`'s *formatter* pipeline.

## Installation

```bash
pnpm add @machize/exports-xlsx @machize/exports
```

No runtime dependencies beyond `@machize/exports` (only for the formatter type).

## Usage

Register the formatter with `@machize/exports` and use the `'xlsx'` format:

```ts
import { exportsPlugin, defineExport } from '@machize/exports'
import { xlsxFormatter } from '@machize/exports-xlsx'

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

## Details

- **Numbers** become numeric cells; **dates** become ISO text; everything else becomes an *inline string* (with XML escaping). `null`/`undefined` produce empty cells.
- One sheet (`Sheet1`). The ZIP uses the **STORE** method (no compression) — valid and opens fine in Excel/LibreOffice.
- The produced `Buffer` passes `unzip -t` (correct CRCs) and opens in Excel/LibreOffice/Google Sheets.

## How it connects to other modules

- **`@machize/exports`** — this is a *formatter* for that package; the export definition comes from there.
- **`@machize/queue` + `@machize/files`** — generate the `.xlsx` in a job and store it for download (large reports).
