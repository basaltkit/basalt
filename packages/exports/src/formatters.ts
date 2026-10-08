/**
 * Per-column rendering hints, taken from an `ExportColumn` and handed to every
 * formatter as the third argument of `render`/`renderStream`. All optional; a
 * formatter that has no use for them (JSON, NDJSON, CSV) simply ignores them.
 */
export interface ExportColumnMeta {
  header: string
  /** What the column holds. Lets a formatter pick a native cell type (e.g. an XLSX date cell). */
  type?: 'text' | 'number' | 'date'
  /** A format code for the column, e.g. an XLSX number format such as `'#,##0.00'` or `'dd/mm/yyyy'`. */
  format?: string
  /** A column width hint, in characters. */
  width?: number
}

/**
 * Turns a header row + data rows into a file. The seam for output formats:
 * CSV/TSV/JSON ship natively; an XLSX or PDF formatter plugs in here (bring the
 * library) without changing any export definition.
 */
export interface ExportFormatter {
  readonly format: string
  readonly contentType: string
  readonly extension: string
  /** `columns` carries the definition's per-column hints; formatters may ignore it. */
  render(headers: string[], rows: unknown[][], columns?: ExportColumnMeta[]): Buffer | Promise<Buffer>
  /**
   * Optional incremental rendering, used by `Exports.stream()`. Pulls rows one
   * at a time and yields pieces of the file as it goes, so memory stays bounded
   * by one chunk instead of the whole dataset. The concatenated output must be
   * byte-identical to `render()`. Formats whose container needs the whole data
   * up front (XLSX's ZIP, PDF) leave this out and are buffer-only.
   */
  renderStream?(
    headers: string[],
    rows: AsyncIterable<unknown[]>,
    columns?: ExportColumnMeta[],
  ): AsyncIterable<string | Buffer>
}

/**
 * How numbers and dates are written as text in a delimited file — e.g. for a
 * spreadsheet or ERP in a Portuguese locale,
 * `{ decimal: ',', thousands: ' ', date: 'dd/mm/yyyy' }` writes `1408278.55`
 * as `1 408 278,55` and a date as `14/03/2026`. `'dd/mm/yyyy'` uses the UTC
 * calendar day; pass a function for any other rendering.
 */
export interface LocaleSpec {
  /** Decimal separator for numbers. */
  decimal: ',' | '.'
  /** Thousands separator for the integer part (e.g. `' '` or `'.'`). Default: none. */
  thousands?: string
  /** How a `Date` is written. Default `'iso'` (`toISOString()`). */
  date?: 'iso' | 'dd/mm/yyyy' | ((date: Date) => string)
}

export interface DelimitedFormatterOptions {
  /** Start the file with a UTF-8 byte-order mark (EF BB BF), so Excel on Windows reads it as UTF-8. Default `false`. */
  bom?: boolean
  /** Locale rendering for numbers and dates. Default: `String(number)` and ISO dates. */
  locale?: LocaleSpec
}

const BOM = '﻿'

function formatNumber(value: number | bigint, locale: LocaleSpec): string {
  const text = String(value)
  // NaN, Infinity and exponent notation keep their shape; only the decimal point is localized.
  if (typeof value === 'number' && (!Number.isFinite(value) || /e/i.test(text))) return text.replace('.', locale.decimal)
  const negative = text.startsWith('-')
  const [integer = '', fraction] = (negative ? text.slice(1) : text).split('.')
  const grouped = locale.thousands ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, locale.thousands) : integer
  return `${negative ? '-' : ''}${grouped}${fraction === undefined ? '' : locale.decimal + fraction}`
}

function formatDate(value: Date, locale: LocaleSpec | undefined): string {
  const style = locale?.date ?? 'iso'
  if (typeof style === 'function') return String(style(value))
  const iso = value.toISOString()
  if (style === 'iso') return iso
  // Derived from the ISO text, so a Date-branded object still renders (and is still guarded).
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso
}

// A spreadsheet evaluates a cell whose text starts with =, +, -, @ or a leading
// tab/CR/LF as a formula, so an exported value like `=WEBSERVICE(...)` runs on open
// (CSV/formula injection). Some spreadsheets also accept the full-width forms
// (＝ ＋ － ＠) or trim leading whitespace before evaluating, so those count too.
// Primitive numbers, bigints and booleans render themselves and can never be a
// formula (a negative number must stay numeric), so they are exempt. Everything
// else — strings, dates, arrays, objects with a custom `toString`, boxed strings —
// is guarded on its FINAL rendered text (a Date-branded object can override
// `toISOString`, so even dates are checked after rendering).
//
// A locale only changes how an exempt number is spelled AFTER the guard decision,
// so a localized negative (`-1 408 278,55`) stays unquoted while every string is
// guarded exactly as before — the guard itself is deliberately not configurable.
const FORMULA_TRIGGER = /^(?:[\t\r\n]|\s*[=+\-@＝＋－＠])/

const cell = (value: unknown, locale?: LocaleSpec): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'bigint') return locale ? formatNumber(value, locale) : String(value)
  if (typeof value === 'boolean') return String(value)
  const text = value instanceof Date ? formatDate(value, locale) : String(value)
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text
}

/**
 * CSV/TSV via a configurable delimiter, with RFC-4180 quoting. The optional
 * `{ bom, locale }` add a UTF-8 BOM and locale number/date rendering.
 */
export class DelimitedFormatter implements ExportFormatter {
  private readonly needsQuote: RegExp
  private readonly bom: string
  private readonly locale: LocaleSpec | undefined
  constructor(
    readonly format: string,
    private readonly delimiter: string,
    readonly contentType: string,
    readonly extension: string,
    options: DelimitedFormatterOptions = {},
  ) {
    // Quote a field that contains the delimiter, a quote, or a line break.
    this.needsQuote = new RegExp(`["\\r\\n${delimiter === '\t' ? '\\t' : delimiter.replace(/[\\\]^-]/g, '\\$&')}]`)
    this.bom = options.bom ? BOM : ''
    this.locale = options.locale
  }

  private line(row: unknown[]): string {
    return row
      .map((value) => {
        const s = cell(value, this.locale)
        return this.needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      })
      .join(this.delimiter)
  }

  render(headers: string[], rows: unknown[][]): Buffer {
    return Buffer.from(this.bom + [headers, ...rows].map((row) => this.line(row)).join('\r\n'))
  }

  async *renderStream(headers: string[], rows: AsyncIterable<unknown[]>): AsyncIterable<string> {
    yield this.bom + this.line(headers)
    for await (const row of rows) yield `\r\n${this.line(row)}`
  }
}

const toObject = (headers: string[], row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(headers.map((h, i) => [h, row[i]]))

const toObjects = (headers: string[], rows: unknown[][]): Record<string, unknown>[] =>
  rows.map((row) => toObject(headers, row))

/** JSON array of `{ header: value }` objects. */
export class JsonFormatter implements ExportFormatter {
  readonly format = 'json'
  readonly contentType = 'application/json'
  readonly extension = 'json'
  render(headers: string[], rows: unknown[][]): Buffer {
    return Buffer.from(JSON.stringify(toObjects(headers, rows), null, 2))
  }

  /** Same bytes as `render()`: each element is indented one level inside `[ … ]`. */
  async *renderStream(headers: string[], rows: AsyncIterable<unknown[]>): AsyncIterable<string> {
    let first = true
    for await (const row of rows) {
      // JSON escapes newlines inside strings, so every '\n' here is structural.
      const element = JSON.stringify(toObject(headers, row), null, 2).replace(/\n/g, '\n  ')
      yield `${first ? '[\n' : ',\n'}  ${element}`
      first = false
    }
    yield first ? '[]' : '\n]'
  }
}

/** Newline-delimited JSON — one object per line, ideal for streaming loads. */
export class NdjsonFormatter implements ExportFormatter {
  readonly format = 'ndjson'
  readonly contentType = 'application/x-ndjson'
  readonly extension = 'ndjson'
  render(headers: string[], rows: unknown[][]): Buffer {
    return Buffer.from(toObjects(headers, rows).map((o) => JSON.stringify(o)).join('\n'))
  }

  async *renderStream(headers: string[], rows: AsyncIterable<unknown[]>): AsyncIterable<string> {
    let first = true
    for await (const row of rows) {
      yield `${first ? '' : '\n'}${JSON.stringify(toObject(headers, row))}`
      first = false
    }
  }
}

export interface CsvFormatterOptions extends DelimitedFormatterOptions {
  /** Field delimiter. Default `','`; `';'` is what spreadsheets expect where the decimal separator is a comma. */
  delimiter?: string
  /** The format name it registers under. Default `'csv'`, which replaces the native csv formatter. */
  format?: string
}

/**
 * A configured CSV formatter — e.g. for a spreadsheet or ERP in a Portuguese
 * locale:
 * `createCsvFormatter({ delimiter: ';', bom: true, locale: { decimal: ',', thousands: ' ', date: 'dd/mm/yyyy' } })`.
 * Register it with `exportsPlugin({ formatters: [...] })`.
 */
export function createCsvFormatter(options: CsvFormatterOptions = {}): DelimitedFormatter {
  const { delimiter = ',', format = 'csv', bom, locale } = options
  if (delimiter.length !== 1 || /["\r\n]/.test(delimiter)) {
    throw new TypeError(
      `A CSV delimiter must be a single character other than a quote or a line break (got ${JSON.stringify(delimiter)}).`,
    )
  }
  const rest: DelimitedFormatterOptions = {}
  if (bom !== undefined) rest.bom = bom
  if (locale !== undefined) rest.locale = locale
  return new DelimitedFormatter(format, delimiter, 'text/csv', 'csv', rest)
}

export const csvFormatter = new DelimitedFormatter('csv', ',', 'text/csv', 'csv')
export const tsvFormatter = new DelimitedFormatter('tsv', '\t', 'text/tab-separated-values', 'tsv')
export const jsonFormatter = new JsonFormatter()
export const ndjsonFormatter = new NdjsonFormatter()

/** The formats available out of the box. */
export const nativeFormatters: ExportFormatter[] = [csvFormatter, tsvFormatter, jsonFormatter, ndjsonFormatter]
