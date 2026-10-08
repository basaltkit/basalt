---
'@basaltkit/exports': minor
---

CSV for Excel/ERP in non-English locales (BK-081): `createCsvFormatter({ delimiter, bom, locale, format })` adds a UTF-8 BOM and `LocaleSpec` number/date rendering (`1408278.55` → `1 408 278,55`, dates → `14/03/2026`). The locale only re-spells primitive numbers and Dates after the formula-injection guard decides, so the guard is unchanged and fail-closed. `DelimitedFormatter` takes an optional fifth `{ bom, locale }` argument. `ExportColumn` gains optional `type`, `format` and `width` hints, passed to formatters as a third `columns: ExportColumnMeta[]` argument of `render`/`renderStream` (existing formatters ignore it). Native formatters' output is unchanged.
