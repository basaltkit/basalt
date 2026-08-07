# @machize/exports-xlsx

## 0.23.0

### Patch Changes

- @machize/exports@0.23.0

## 0.22.0

### Patch Changes

- @machize/exports@0.22.0

## 0.21.0

### Patch Changes

- @machize/exports@0.21.0

## 0.20.0

### Minor Changes

- 9415b25: New package: `@machize/exports-xlsx` — an XLSX formatter for `@machize/exports`.

  `xlsxFormatter` renders an export definition to a valid single-sheet `.xlsx` (Office Open XML SpreadsheetML) with **zero dependencies**: it ships a small STORE-method ZIP writer (with CRC32) and emits the OOXML parts by hand — headers, escaped inline strings, numeric cells, ISO dates. Register it with `exportsPlugin({ formatters: [xlsxFormatter] })` and use the `'xlsx'` format, or call `xlsxFormatter.render(headers, rows)` directly. The output passes `unzip -t` (correct CRCs) and opens in Excel/LibreOffice/Google Sheets. This is the concrete driver the `@machize/exports` formatter seam was designed for. `zip()` is also exported for other OOXML/ZIP needs. Fully unit-tested, including round-tripping the archive through a minimal ZIP reader.

### Patch Changes

- @machize/exports@0.20.0
