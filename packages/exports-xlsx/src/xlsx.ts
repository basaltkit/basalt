import type { ExportColumnMeta, ExportFormatter } from '@basaltkit/exports'
import { zip } from './zip.js'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string)

/**
 * Characters XML 1.0 forbids outright (only tab, LF and CR are legal below 0x20).
 * A single one of them in a cell makes the whole sheet unparseable — Excel refuses
 * to open the file — so they are encoded with OOXML's `_xHHHH_` escape instead.
 * A literal `_xHHHH_` in the data is escaped first, so the encoding round-trips.
 */
const XML_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g
const LITERAL_ESCAPE = /_(x[0-9A-Fa-f]{4})_/g

const escapeControlChars = (value: string): string =>
  value
    .replace(LITERAL_ESCAPE, '_x005F_$1_')
    .replace(XML_CONTROL, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)

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
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(escapeControlChars(text))}</t></is></c>`
}

/** Days since 1899-12-30 (Excel's 1900 date system), from the UTC instant; `undefined` for a non-Date or invalid date. */
function dateSerial(value: Date): number | undefined {
  let time: number
  try {
    // Date.prototype.getTime on the real internal slot — a Date-branded object throws and stays text.
    time = Date.prototype.getTime.call(value)
  } catch {
    return undefined
  }
  return Number.isFinite(time) ? time / 86_400_000 + 25_569 : undefined
}

/** Assigns one `cellXfs` index per distinct number-format code (index 0 is the default style). */
class Styles {
  private readonly codes: string[] = []

  index(code: string): number {
    let i = this.codes.indexOf(code)
    if (i === -1) i = this.codes.push(code) - 1
    return i + 1
  }

  xml(): string {
    const numFmts = this.codes
      .map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escapeXml(code)}"/>`)
      .join('')
    const xfs = this.codes
      .map((_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`)
      .join('')
    return `${XML}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
      this.codes.length ? `<numFmts count="${this.codes.length}">${numFmts}</numFmts>` : ''
    }<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${
      this.codes.length + 1
    }"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${xfs}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  }
}

interface SheetConfig {
  freezeHeader: boolean
  dateFormat: string
  widths: (number | undefined)[] | undefined
}

/** A data cell with native dates and per-column number formats (only for `createXlsxFormatter`). */
function styledCell(value: unknown, ref: string, column: ExportColumnMeta | undefined, config: SheetConfig, styles: Styles): string {
  if (value instanceof Date) {
    const serial = dateSerial(value)
    if (serial !== undefined) return `<c r="${ref}" s="${styles.index(column?.format ?? config.dateFormat)}"><v>${serial}</v></c>`
  }
  if (typeof value === 'number' && Number.isFinite(value) && column?.format) {
    return `<c r="${ref}" s="${styles.index(column.format)}"><v>${value}</v></c>`
  }
  return cell(value, ref)
}

function sheetXml(
  headers: string[],
  rows: unknown[][],
  columns: ExportColumnMeta[] | undefined,
  config: SheetConfig | undefined,
  styles: Styles | undefined,
): string {
  const line = (cells: unknown[], rowIndex: number): string =>
    `<row r="${rowIndex}">${cells
      .map((v, col) => {
        const ref = columnName(col) + rowIndex
        return config && styles && rowIndex > 1 ? styledCell(v, ref, columns?.[col], config, styles) : cell(v, ref)
      })
      .join('')}</row>`
  const body = [line(headers, 1), ...rows.map((r, i) => line(r, i + 2))].join('')

  let before = ''
  if (config?.freezeHeader) {
    before += `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
  }
  if (config) {
    const cols = headers
      .map((_, i) => {
        const width = config.widths?.[i] ?? columns?.[i]?.width
        return width !== undefined && Number.isFinite(width) && width > 0
          ? `<col min="${i + 1}" max="${i + 1}" width="${Math.min(width, 255)}" customWidth="1"/>`
          : ''
      })
      .join('')
    if (cols) before += `<cols>${cols}</cols>`
  }
  return `${XML}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${before}<sheetData>${body}</sheetData></worksheet>`
}

const SHEET_CT = `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
const STYLES_CT = `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`

const contentTypes = (withStyles: boolean): string => `${XML}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${SHEET_CT}${
  withStyles ? STYLES_CT : ''
}</Types>`

const ROOT_RELS = `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

const workbook = (sheetName: string): string => `${XML}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`

const workbookRels = (withStyles: boolean): string => `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${
  withStyles
    ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    : ''
}</Relationships>`

const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * XLSX formatter for `@basaltkit/exports` — dependency-free. Emits a valid
 * single-sheet .xlsx (Office Open XML) with inline strings and numeric cells
 * (dates as ISO text). Register it: `exportsPlugin({ formatters: [xlsxFormatter] })`.
 * For native date cells, number formats, a sheet name, a frozen header or
 * column widths, use `createXlsxFormatter()`.
 */
export const xlsxFormatter: ExportFormatter = {
  format: 'xlsx',
  contentType: CONTENT_TYPE,
  extension: 'xlsx',
  render(headers, rows) {
    return zip([
      { name: '[Content_Types].xml', data: Buffer.from(contentTypes(false)) },
      { name: '_rels/.rels', data: Buffer.from(ROOT_RELS) },
      { name: 'xl/workbook.xml', data: Buffer.from(workbook('Sheet1')) },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels(false)) },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(headers, rows, undefined, undefined, undefined)) },
    ])
  },
}

export interface XlsxFormatterOptions {
  /** The worksheet name. 1–31 characters, none of `[ ] : * ? / \`, not starting or ending with `'`. Default `'Sheet1'`. */
  sheetName?: string
  /** Freeze the header row so it stays visible while scrolling. Default `false`. */
  freezeHeader?: boolean
  /** Number format for date cells when the column declares no `format`. Default `'yyyy-mm-dd'`. */
  dateFormat?: string
  /** Column widths in characters, by column index; overrides the columns' `width` hints. */
  widths?: (number | undefined)[]
  /** The format name it registers under. Default `'xlsx'`. */
  format?: string
}

const INVALID_SHEET_NAME = /[[\]:*?/\\]/

function validateSheetName(name: string): void {
  if (name.length < 1 || name.length > 31 || INVALID_SHEET_NAME.test(name) || name.startsWith("'") || name.endsWith("'")) {
    throw new TypeError(
      `Invalid XLSX sheet name ${JSON.stringify(name)}: it must be 1–31 characters, contain none of [ ] : * ? / \\ and not start or end with an apostrophe.`,
    )
  }
}

/**
 * A configured XLSX formatter. On top of `xlsxFormatter` it writes `Date`
 * values as real date cells (an Excel serial number with a date format, from
 * the UTC instant), applies a column's `format` (e.g. `'#,##0.00'`) to its
 * numbers and dates, sets column widths (`widths` or the columns' `width`),
 * names the sheet and can freeze the header row:
 *
 * ```ts
 * createXlsxFormatter({ sheetName: 'Facturas', freezeHeader: true, dateFormat: 'dd/mm/yyyy' })
 * ```
 */
export function createXlsxFormatter(options: XlsxFormatterOptions = {}): ExportFormatter {
  const sheetName = options.sheetName ?? 'Sheet1'
  validateSheetName(sheetName)
  const config: SheetConfig = {
    freezeHeader: options.freezeHeader ?? false,
    dateFormat: options.dateFormat ?? 'yyyy-mm-dd',
    widths: options.widths ? [...options.widths] : undefined,
  }
  return {
    format: options.format ?? 'xlsx',
    contentType: CONTENT_TYPE,
    extension: 'xlsx',
    render(headers, rows, columns) {
      const styles = new Styles()
      const sheet = sheetXml(headers, rows, columns, config, styles)
      return zip([
        { name: '[Content_Types].xml', data: Buffer.from(contentTypes(true)) },
        { name: '_rels/.rels', data: Buffer.from(ROOT_RELS) },
        { name: 'xl/workbook.xml', data: Buffer.from(workbook(sheetName)) },
        { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels(true)) },
        { name: 'xl/styles.xml', data: Buffer.from(styles.xml()) },
        { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
      ])
    },
  }
}
