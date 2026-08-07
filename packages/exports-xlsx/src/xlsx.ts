import type { ExportFormatter } from '@machize/exports'
import { zip } from './zip.js'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string)

/** 0 → A, 25 → Z, 26 → AA … */
function columnName(index: number): string {
  let name = ''
  let n = index
  do {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return name
}

function cell(value: unknown, ref: string): string {
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`
  const text = value instanceof Date ? value.toISOString() : String(value)
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
}

function sheetXml(headers: string[], rows: unknown[][]): string {
  const line = (cells: unknown[], rowIndex: number): string =>
    `<row r="${rowIndex}">${cells.map((v, col) => cell(v, columnName(col) + rowIndex)).join('')}</row>`
  const body = [line(headers, 1), ...rows.map((r, i) => line(r, i + 2))].join('')
  return `${XML}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

const CONTENT_TYPES = `${XML}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`

const ROOT_RELS = `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

const WORKBOOK = `${XML}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`

const WORKBOOK_RELS = `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`

/**
 * XLSX formatter for `@machize/exports` — dependency-free. Emits a valid
 * single-sheet .xlsx (Office Open XML SpreadsheetML) with inline strings and
 * numeric cells. Register it: `exportsPlugin({ formatters: [xlsxFormatter] })`.
 */
export const xlsxFormatter: ExportFormatter = {
  format: 'xlsx',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  extension: 'xlsx',
  render(headers, rows) {
    return zip([
      { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES) },
      { name: '_rels/.rels', data: Buffer.from(ROOT_RELS) },
      { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK) },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS) },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(headers, rows)) },
    ])
  },
}
