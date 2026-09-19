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
  /**
   * Optional incremental rendering, used by `Exports.stream()`. Pulls rows one
   * at a time and yields pieces of the file as it goes, so memory stays bounded
   * by one chunk instead of the whole dataset. The concatenated output must be
   * byte-identical to `render()`. Formats whose container needs the whole data
   * up front (XLSX's ZIP, PDF) leave this out and are buffer-only.
   */
  renderStream?(headers: string[], rows: AsyncIterable<unknown[]>): AsyncIterable<string | Buffer>
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
const FORMULA_TRIGGER = /^(?:[\t\r\n]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  const text = value instanceof Date ? value.toISOString() : String(value)
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text
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

  private line(row: unknown[]): string {
    return row
      .map((value) => {
        const s = cell(value)
        return this.needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      })
      .join(this.delimiter)
  }

  render(headers: string[], rows: unknown[][]): Buffer {
    return Buffer.from([headers, ...rows].map((row) => this.line(row)).join('\r\n'))
  }

  async *renderStream(headers: string[], rows: AsyncIterable<unknown[]>): AsyncIterable<string> {
    yield this.line(headers)
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

export const csvFormatter = new DelimitedFormatter('csv', ',', 'text/csv', 'csv')
export const tsvFormatter = new DelimitedFormatter('tsv', '\t', 'text/tab-separated-values', 'tsv')
export const jsonFormatter = new JsonFormatter()
export const ndjsonFormatter = new NdjsonFormatter()

/** The formats available out of the box. */
export const nativeFormatters: ExportFormatter[] = [csvFormatter, tsvFormatter, jsonFormatter, ndjsonFormatter]
