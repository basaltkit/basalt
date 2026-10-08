import type { LocaleSpec } from './formatters.js'
import { DelimitedParseError, parseDelimited, type DelimitedInput, type ParseDelimitedOptions } from './parse.js'

/** Built-in cell parsers. A function parser receives the trimmed, non-empty text and returns the value (or throws). */
export type ImportParser = 'text' | 'integer' | 'decimal' | 'date' | ((value: string) => unknown)

export interface ImportColumn<T> {
  /** The property of the parsed row this column fills. */
  key: keyof T & string
  /**
   * File headers accepted for this column (synonyms). Matching ignores case,
   * accents and repeated whitespace, so `'Número'` also matches `'NUMERO'`.
   */
  headers: string[]
  /** The header must be present and every row must have a value. Default `false`. */
  required?: boolean
  /** How the cell text becomes a value. Default `'text'`. */
  parse?: ImportParser
}

export interface ImportDefinition<T> {
  name: string
  columns: ImportColumn<T>[]
  /**
   * How decimals and dates are read. Default `{ decimal: '.', date: 'iso' }`.
   * `date` accepts `'iso'` (`yyyy-mm-dd` or a full ISO timestamp with an offset)
   * or `'dd/mm/yyyy'`; a formatting function is not a parser — use a function
   * `parse` on the column instead.
   */
  locale?: LocaleSpec
  /** Field delimiter. Default `','`. */
  delimiter?: string
  /** A leading UTF-8 BOM is stripped (`'optional'`, the default) or rejected (`'forbid'`). */
  bom?: 'optional' | 'forbid'
  /** Most data rows (header excluded). A longer file fails as a whole with `TOO_MANY_ROWS`. Default 10 000. */
  maxRows?: number
  /** Longest field, in characters. Default 1 048 576. */
  maxFieldLength?: number
  /** A file header no column claims is a warning (`'warn'`, the default) or a file-level error (`'error'`). */
  unknownColumns?: 'warn' | 'error'
  /** Stop collecting row errors after this many (a final `TOO_MANY_ERRORS` entry says so). Default 1 000. */
  maxErrors?: number
}

export type ImportIssueCode =
  // file-level — the import yields no rows
  | 'UNTERMINATED_QUOTE'
  | 'INVALID_QUOTE'
  | 'TOO_MANY_ROWS'
  | 'FIELD_TOO_LARGE'
  | 'BOM_FORBIDDEN'
  | 'INVALID_ENCODING'
  | 'EMPTY_FILE'
  | 'MISSING_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'UNKNOWN_COLUMN'
  | 'TOO_MANY_ERRORS'
  // row-level — the row is left out
  | 'COLUMN_COUNT'
  | 'REQUIRED'
  | 'INVALID_INTEGER'
  | 'INVALID_DECIMAL'
  | 'AMBIGUOUS_DECIMAL'
  | 'INVALID_DATE'
  | 'INVALID_VALUE'

/** A problem tied to a physical line of the file and, when it applies, a column key (or the raw header). */
export interface ImportIssue {
  line: number
  column?: string
  code: ImportIssueCode
  message: string
}

export interface ImportResult<T> {
  /** Rows that parsed cleanly, with the line each starts on. Empty when any file-level error occurred. */
  rows: { line: number; value: T }[]
  /** Row and file errors. Import only when this is empty — or import `rows` and show these. */
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

const fold = (header: string): string =>
  header.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Declares a typed CSV import: which file headers map to which keys, how each
 * cell is parsed, and the locale for numbers and dates. Validated up front
 * (duplicate keys or headers throw `TypeError`); read a file with `readImport`.
 */
export function defineImport<T>(definition: ImportDefinition<T>): ImportDefinition<T> {
  const keys = new Set<string>()
  const headers = new Map<string, string>()
  for (const column of definition.columns) {
    if (keys.has(column.key)) throw new TypeError(`Import "${definition.name}": duplicate column key "${column.key}".`)
    keys.add(column.key)
    if (column.headers.length === 0) throw new TypeError(`Import "${definition.name}": column "${column.key}" has no headers.`)
    for (const header of column.headers) {
      const folded = fold(header)
      const owner = headers.get(folded)
      if (owner !== undefined) {
        throw new TypeError(`Import "${definition.name}": header "${header}" is claimed by both "${owner}" and "${column.key}".`)
      }
      headers.set(folded, column.key)
    }
    if (column.parse === 'date' && typeof definition.locale?.date === 'function') {
      throw new TypeError(
        `Import "${definition.name}": locale.date is a formatting function; give column "${column.key}" a function parser instead.`,
      )
    }
  }
  return definition
}

class CellError extends Error {
  constructor(
    readonly code: ImportIssueCode,
    message: string,
  ) {
    super(message)
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Strict locale number parsing. The separator that is NOT the decimal one is
 * only accepted as a thousands separator in groups of three, so with a comma
 * decimal `1.250,50` is 1250.5 while `12.5` is AMBIGUOUS — never silently read
 * as 125 or 12.5, which is how a price ends up off by a factor of 1 000.
 */
function parseNumber(text: string, locale: LocaleSpec, integer: boolean): number {
  const decimal = locale.decimal
  const other = decimal === ',' ? '.' : ','
  const separators = new Set([other])
  if (locale.thousands) {
    separators.add(locale.thousands)
    // a space separator also accepts the non-breaking spaces spreadsheets write
    if (/^\s$/.test(locale.thousands)) for (const s of [' ', ' ', ' ']) separators.add(s)
  }
  separators.delete(decimal)
  const sep = `[${[...separators].map(escapeRegExp).join('')}]`
  const dec = escapeRegExp(decimal)
  const fraction = integer ? '' : `(?:${dec}\\d+)?`
  const plain = new RegExp(`^[-+]?\\d+${fraction}$`)
  const grouped = new RegExp(`^[-+]?\\d{1,3}(${sep})\\d{3}(?:\\1\\d{3})*${fraction}$`)
  const kind = integer ? 'INVALID_INTEGER' : 'INVALID_DECIMAL'

  if (!plain.test(text) && !grouped.test(text)) {
    if (!integer && new RegExp(sep).test(text) && /^[-+]?[\d\s.,  ]+$/.test(text)) {
      throw new CellError(
        'AMBIGUOUS_DECIMAL',
        `"${text}" is ambiguous: "${other}" is only accepted as a thousands separator in groups of three, and the decimal separator is "${decimal}".`,
      )
    }
    throw new CellError(kind, `"${text}" is not a valid ${integer ? 'integer' : 'number'} (decimal separator "${decimal}").`)
  }
  const normalized = text.replace(new RegExp(sep, 'g'), '').replace(decimal, '.')
  const value = Number(normalized)
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    throw new CellError(kind, `"${text}" is out of range.`)
  }
  return value
}

function calendarDate(year: number, month: number, day: number, text: string): Date {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new CellError('INVALID_DATE', `"${text}" is not a calendar date.`)
  }
  return date
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/** Dates become UTC midnight of the calendar day (or the exact instant of an ISO timestamp). */
function parseDate(text: string, locale: LocaleSpec): Date {
  if (locale.date === 'dd/mm/yyyy') {
    const m = DMY.exec(text)
    if (!m) throw new CellError('INVALID_DATE', `"${text}" is not a dd/mm/yyyy date.`)
    return calendarDate(Number(m[3]), Number(m[2]), Number(m[1]), text)
  }
  const m = ISO_DATE.exec(text)
  if (m) return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]), text)
  const t = ISO_TIMESTAMP.exec(text)
  if (t) {
    calendarDate(Number(t[1]), Number(t[2]), Number(t[3]), text)
    const date = new Date(text)
    if (Number.isFinite(date.getTime())) return date
  }
  throw new CellError('INVALID_DATE', `"${text}" is not an ISO date (yyyy-mm-dd).`)
}

function parseCell(text: string, parser: ImportParser, locale: LocaleSpec): unknown {
  if (typeof parser === 'function') {
    try {
      return parser(text)
    } catch (error) {
      throw new CellError('INVALID_VALUE', error instanceof Error ? error.message : `"${text}" is not valid.`)
    }
  }
  switch (parser) {
    case 'text':
      return text
    case 'integer':
      return parseNumber(text, locale, true)
    case 'decimal':
      return parseNumber(text, locale, false)
    case 'date':
      return parseDate(text, locale)
  }
}

/**
 * Reads a delimited file against an import definition. It never throws on bad
 * data: file-level problems (a malformed file, a missing or duplicate column,
 * too many rows) come back as errors with no rows at all, and each bad row is
 * left out with one error per bad cell — `{ line, column, code, message }`,
 * ready for a preview screen. Cells are trimmed; an empty optional cell is `null`.
 */
export async function readImport<T>(definition: ImportDefinition<T>, input: DelimitedInput): Promise<ImportResult<T>> {
  const locale: LocaleSpec = definition.locale ?? { decimal: '.', date: 'iso' }
  const maxRows = definition.maxRows ?? 10_000
  const maxErrors = definition.maxErrors ?? 1_000
  const rows: { line: number; value: T }[] = []
  const errors: ImportIssue[] = []
  const warnings: ImportIssue[] = []
  const fileError = (issue: ImportIssue): ImportResult<T> => ({ rows: [], errors: [issue], warnings })

  const options: ParseDelimitedOptions ={ maxRows: maxRows + 1 }
  if (definition.delimiter !== undefined) options.delimiter = definition.delimiter
  if (definition.bom !== undefined) options.bom = definition.bom
  if (definition.maxFieldLength !== undefined) options.maxFieldLength = definition.maxFieldLength

  const byHeader = new Map<string, ImportColumn<T>>()
  for (const column of definition.columns) for (const header of column.headers) byHeader.set(fold(header), column)

  let mapping: (ImportColumn<T> | undefined)[] | undefined
  let headerCount = 0
  let capped = false

  try {
    for await (const record of parseDelimited(input, options)) {
      if (!mapping) {
        // the header row
        headerCount = record.cells.length
        mapping = []
        const seen = new Map<string, string>()
        const fileErrors: ImportIssue[] = []
        for (const raw of record.cells) {
          const column = byHeader.get(fold(raw))
          mapping.push(column)
          if (!column) {
            const issue: ImportIssue = { line: record.line, column: raw, code: 'UNKNOWN_COLUMN', message: `Unknown column "${raw}".` }
            if (definition.unknownColumns === 'error') fileErrors.push(issue)
            else warnings.push(issue)
            continue
          }
          const previous = seen.get(column.key)
          if (previous !== undefined) {
            fileErrors.push({
              line: record.line,
              column: column.key,
              code: 'DUPLICATE_COLUMN',
              message: `Columns "${previous}" and "${raw}" both map to "${column.key}".`,
            })
          }
          seen.set(column.key, raw)
        }
        for (const column of definition.columns) {
          if (column.required && !seen.has(column.key)) {
            fileErrors.push({
              line: record.line,
              column: column.key,
              code: 'MISSING_COLUMN',
              message: `Missing required column "${column.headers[0]}".`,
            })
          }
        }
        if (fileErrors.length) return { rows: [], errors: fileErrors, warnings }
        continue
      }

      const rowErrors: ImportIssue[] = []
      if (record.cells.length !== headerCount) {
        rowErrors.push({
          line: record.line,
          code: 'COLUMN_COUNT',
          message: `Expected ${headerCount} fields, found ${record.cells.length}.`,
        })
      } else {
        const value: Record<string, unknown> = {}
        for (const column of definition.columns) value[column.key] = null
        record.cells.forEach((rawCell, i) => {
          const column = mapping![i]
          if (!column) return
          const text = rawCell.trim()
          if (text === '') {
            if (column.required) {
              rowErrors.push({ line: record.line, column: column.key, code: 'REQUIRED', message: `"${column.headers[0]}" is required.` })
            }
            return
          }
          try {
            value[column.key] = parseCell(text, column.parse ?? 'text', locale)
          } catch (error) {
            if (!(error instanceof CellError)) throw error
            rowErrors.push({ line: record.line, column: column.key, code: error.code, message: error.message })
          }
        })
        if (rowErrors.length === 0) rows.push({ line: record.line, value: value as T })
      }
      if (!capped && rowErrors.length) {
        const room = maxErrors - errors.length
        errors.push(...rowErrors.slice(0, room))
        if (rowErrors.length > room) {
          capped = true
          errors.push({ line: record.line, code: 'TOO_MANY_ERRORS', message: `More than ${maxErrors} errors; stopped reporting.` })
        }
      }
    }
  } catch (error) {
    if (!(error instanceof DelimitedParseError)) throw error
    const reason = error.reason === 'TOO_MANY_ROWS' ? `The file has more than ${maxRows} rows.` : error.message
    return fileError({ line: error.line, code: error.reason, message: reason })
  }

  if (!mapping) return fileError({ line: 1, code: 'EMPTY_FILE', message: 'The file is empty (no header row).' })
  return { rows, errors, warnings }
}
