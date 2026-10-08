import { BasaltError } from '@basaltkit/core'

/** Why a delimited file could not be read. Each one stops the parse. */
export type DelimitedParseCode =
  | 'UNTERMINATED_QUOTE'
  | 'INVALID_QUOTE'
  | 'TOO_MANY_ROWS'
  | 'FIELD_TOO_LARGE'
  | 'BOM_FORBIDDEN'
  | 'INVALID_ENCODING'

/**
 * A malformed delimited file. `reason` says what went wrong and `line` is the
 * physical line (1-based) where it was detected — or, for an unterminated quote,
 * where the quoted field started. `code` is `CSV_<reason>`.
 */
export class DelimitedParseError extends BasaltError {
  readonly status = 400
  constructor(
    readonly reason: DelimitedParseCode,
    readonly line: number,
    message: string,
  ) {
    super(`CSV_${reason}`, `Line ${line}: ${message}`, { details: { reason, line } })
  }
}

/** One record: its cells and the physical line (1-based) where it starts. */
export interface DelimitedRecord {
  line: number
  cells: string[]
}

export interface ParseDelimitedOptions {
  /** Field delimiter, one character. Default `','`. */
  delimiter?: string
  /** Quote character, one character. Default `'"'`. */
  quote?: string
  /** A leading UTF-8 BOM is stripped (`'optional'`, the default) or rejected (`'forbid'`). */
  bom?: 'optional' | 'forbid'
  /** Most records to read, header included; one more fails with `TOO_MANY_ROWS` before it is yielded. Default: no limit. */
  maxRows?: number
  /** Longest field, in characters; a longer one fails with `FIELD_TOO_LARGE`. Default 1 048 576. */
  maxFieldLength?: number
}

export type DelimitedInput = string | Uint8Array | AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>

const DEFAULT_MAX_FIELD_LENGTH = 1_048_576

async function* textChunks(input: DelimitedInput): AsyncGenerator<string> {
  if (typeof input === 'string') {
    yield input
    return
  }
  // ignoreBOM keeps a leading BOM in the text so the `bom` option decides; fatal rejects invalid UTF-8.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const decode = (bytes: Uint8Array, stream: boolean): string => {
    try {
      return decoder.decode(bytes, { stream })
    } catch {
      throw new DelimitedParseError('INVALID_ENCODING', 1, 'the file is not valid UTF-8.')
    }
  }
  if (input instanceof Uint8Array) {
    yield decode(input, false)
    return
  }
  for await (const chunk of input as AsyncIterable<string | Uint8Array>) {
    yield typeof chunk === 'string' ? chunk : decode(chunk, true)
  }
  const tail = decode(new Uint8Array(0), false)
  if (tail) yield tail
}

/**
 * Reads a delimited file (RFC 4180 CSV, or any single-character delimiter) as
 * an async iterator of records. Fields may be quoted to hold the delimiter,
 * line breaks or doubled quotes (`""`); CRLF, LF and lone CR all end a record.
 * Every record carries the physical line it starts on, counted across line
 * breaks inside quoted fields, so errors point at the right line of the file.
 * Blank lines are skipped.
 *
 * It is strict: a quote that never closes, text after a closing quote, or a
 * quote inside an unquoted field throws `DelimitedParseError` instead of
 * silently swallowing the rest of the file. `maxRows` and `maxFieldLength` are
 * checked while streaming, so an oversized file fails without being read in full.
 */
export async function* parseDelimited(
  input: DelimitedInput,
  options: ParseDelimitedOptions = {},
): AsyncGenerator<DelimitedRecord> {
  const delimiter = options.delimiter ?? ','
  const quote = options.quote ?? '"'
  if (delimiter.length !== 1 || quote.length !== 1 || delimiter === quote || /[\r\n]/.test(delimiter + quote)) {
    throw new TypeError('The delimiter and the quote must be two different single characters other than a line break.')
  }
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY
  const maxField = options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH

  let line = 1 // physical line of the current character
  let prevCR = false
  let recordLine = 1
  let atRecordStart = true
  let quoteLine = 1
  let first = true
  let skipLF = false

  let field = ''
  let record: string[] = []
  let inQuotes = false
  let afterQuote = false // just closed a quoted field
  let quoted = false // the current field was quoted
  let count = 0

  const tooLarge = (): DelimitedParseError =>
    new DelimitedParseError('FIELD_TOO_LARGE', line, `a field is longer than ${maxField} characters.`)

  // Ends the current record; returns it unless it is a blank line.
  const endRecord = (): DelimitedRecord | undefined => {
    record.push(field)
    const done = record
    const blank = done.length === 1 && done[0] === '' && !quoted
    field = ''
    record = []
    quoted = false
    afterQuote = false
    atRecordStart = true
    if (blank) return undefined
    if (++count > maxRows) {
      throw new DelimitedParseError('TOO_MANY_ROWS', recordLine, `the file has more than ${maxRows} rows.`)
    }
    return { line: recordLine, cells: done }
  }

  for await (let chunk of textChunks(input)) {
    if (first && chunk.length > 0) {
      first = false
      if (chunk.charCodeAt(0) === 0xfeff) {
        if (options.bom === 'forbid') throw new DelimitedParseError('BOM_FORBIDDEN', 1, 'the file starts with a byte-order mark.')
        chunk = chunk.slice(1)
      }
    }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!
      if (prevCR && c !== '\n') line++
      if (atRecordStart) {
        recordLine = line
        atRecordStart = false
      }

      if (inQuotes) {
        if (c === quote) {
          inQuotes = false
          afterQuote = true
        } else {
          field += c
          if (field.length > maxField) throw tooLarge()
        }
      } else if (skipLF && c === '\n') {
        // the LF of a CRLF that already ended the record
        atRecordStart = true
      } else if (afterQuote) {
        if (c === quote) {
          // a doubled quote inside a quoted field
          field += quote
          if (field.length > maxField) throw tooLarge()
          inQuotes = true
          afterQuote = false
        } else if (c === delimiter) {
          record.push(field)
          field = ''
          afterQuote = false
          quoted = false
        } else if (c === '\r' || c === '\n') {
          const out = endRecord()
          if (out) yield out
        } else {
          throw new DelimitedParseError('INVALID_QUOTE', line, `unexpected ${JSON.stringify(c)} after a closing quote.`)
        }
      } else if (c === quote) {
        if (field !== '') {
          throw new DelimitedParseError('INVALID_QUOTE', line, 'a quote inside an unquoted field (quote the whole field and double the quote).')
        }
        inQuotes = true
        quoted = true
        quoteLine = line
      } else if (c === delimiter) {
        record.push(field)
        field = ''
      } else if (c === '\r' || c === '\n') {
        const out = endRecord()
        if (out) yield out
      } else {
        field += c
        if (field.length > maxField) throw tooLarge()
      }

      skipLF = !inQuotes && c === '\r'
      if (c === '\n') line++
      prevCR = c === '\r'
    }
  }

  if (inQuotes) {
    throw new DelimitedParseError('UNTERMINATED_QUOTE', quoteLine, 'a quoted field is never closed.')
  }
  if (!atRecordStart) {
    const out = endRecord()
    if (out) yield out
  }
}
