/**
 * Turns a header row + data rows into a file. The seam for output formats:
 * CSV/TSV/JSON ship natively; an XLSX or PDF formatter plugs in here (bring the
 * library) without changing any export definition.
 */
export interface ExportFormatter {
  readonly format: string
  readonly contentType: string
  readonly extension: string
  render(headers: string[], rows: unknown[][]): Buffer | Promise<Buffer>
}

// A spreadsheet evaluates a cell whose text starts with =, +, -, @ or a leading
// tab/CR as a formula, so an exported value like `=WEBSERVICE(...)` runs on open
// (CSV/formula injection). Only strings are risky — numbers and dates render
// themselves and can never be a formula — so guard on the original type.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  const text = String(value)
  return typeof value === 'string' && FORMULA_TRIGGER.test(text) ? `'${text}` : text
}

/** CSV/TSV via a configurable delimiter, with RFC-4180 quoting. */
export class DelimitedFormatter implements ExportFormatter {
  private readonly needsQuote: RegExp
  constructor(
    readonly format: string,
    private readonly delimiter: string,
    readonly contentType: string,
    readonly extension: string,
  ) {
    // Quote a field that contains the delimiter, a quote, or a line break.
    this.needsQuote = new RegExp(`["\\r\\n${delimiter === '\t' ? '\\t' : delimiter}]`)
  }

  render(headers: string[], rows: unknown[][]): Buffer {
    const escape = (value: unknown): string => {
      const s = cell(value)
      return this.needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [headers, ...rows].map((row) => row.map(escape).join(this.delimiter))
    return Buffer.from(lines.join('\r\n'))
  }
}

const toObjects = (headers: string[], rows: unknown[][]): Record<string, unknown>[] =>
  rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]])))

/** JSON array of `{ header: value }` objects. */
export class JsonFormatter implements ExportFormatter {
  readonly format = 'json'
  readonly contentType = 'application/json'
  readonly extension = 'json'
  render(headers: string[], rows: unknown[][]): Buffer {
    return Buffer.from(JSON.stringify(toObjects(headers, rows), null, 2))
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
}

export const csvFormatter = new DelimitedFormatter('csv', ',', 'text/csv', 'csv')
export const tsvFormatter = new DelimitedFormatter('tsv', '\t', 'text/tab-separated-values', 'tsv')
export const jsonFormatter = new JsonFormatter()
export const ndjsonFormatter = new NdjsonFormatter()

/** The formats available out of the box. */
export const nativeFormatters: ExportFormatter[] = [csvFormatter, tsvFormatter, jsonFormatter, ndjsonFormatter]
