---
'@basaltkit/exports-xlsx': minor
---

`createXlsxFormatter({ sheetName, freezeHeader, dateFormat, widths, format })` (BK-081): Dates become real date cells (Excel serial + date number format), columns' `format` hints become per-column number formats via a new `xl/styles.xml`, widths become `<cols>`, the header row can be frozen and the sheet named (validated and XML-escaped). The default `xlsxFormatter` output is unchanged.
