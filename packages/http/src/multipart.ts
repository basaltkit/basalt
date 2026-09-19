import { HttpError } from './errors.js'

/**
 * In-house streaming `multipart/form-data` parser (RFC 7578 / RFC 2046 §5.1).
 *
 * Push-based and synchronous: feed it chunks with {@link MultipartParser.write}
 * in arrival order, and it calls back with part boundaries and part data. It
 * never buffers a part body — only a delimiter-sized tail across chunk splits,
 * and a part's header block (bounded by `maxHeaderBytes`). Every violation is
 * thrown as an {@link HttpError} with a fixed message that never quotes input.
 */

const CR = 0x0d
const LF = 0x0a
const DASH = 0x2d
const SPACE = 0x20
const TAB = 0x09
const EMPTY = Buffer.alloc(0)
const HEADER_END = Buffer.from('\r\n\r\n')

/** Most header lines a single part may carry. */
const MAX_PART_HEADERS = 16
/** Most transport-padding bytes tolerated after a boundary (RFC 2046 LWSP). */
const MAX_PADDING = 64

export const malformed = (message = 'Malformed multipart body.'): HttpError =>
  new HttpError(400, 'MALFORMED_MULTIPART', message)

/** Headers of one part, as the parser hands them to {@link MultipartHandlers.onPartStart}. */
export interface PartHeaders {
  /** The form field name (`Content-Disposition: form-data; name=…`). */
  name: string
  /** Present (possibly empty) only for a file part; raw and UNSANITISED. */
  filename?: string
  /** The part's declared media type essence, lower-cased, parameters dropped. */
  contentType?: string
}

export interface MultipartHandlers {
  onPartStart(part: PartHeaders): void
  onPartData(chunk: Buffer): void
  onPartEnd(): void
}

type State = 'preamble' | 'boundary' | 'headers' | 'body' | 'epilogue'

export class MultipartParser {
  private state: State = 'preamble'
  private readonly delimiter: Buffer
  // A virtual CRLF before the first byte lets the opening boundary (which has
  // no preceding CRLF) match the same `CRLF--boundary` delimiter as the others.
  private carry: Buffer = Buffer.from('\r\n')
  private header: Buffer = EMPTY
  private padding = 0

  constructor(
    boundary: string,
    private readonly handlers: MultipartHandlers,
    private readonly maxHeaderBytes = 8 * 1024,
  ) {
    this.delimiter = Buffer.from(`\r\n--${boundary}`, 'latin1')
  }

  /** True once the closing delimiter (`--boundary--`) has been seen. */
  get complete(): boolean {
    return this.state === 'epilogue'
  }

  write(chunk: Buffer): void {
    if (this.state === 'epilogue') return
    let buf = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk
    this.carry = EMPTY
    let pos = 0
    const keep = this.delimiter.length - 1
    while (pos < buf.length) {
      switch (this.state) {
        case 'preamble': {
          const at = buf.indexOf(this.delimiter, pos)
          if (at === -1) {
            // The preamble is discarded; only a possible delimiter prefix is kept.
            this.carry = buf.subarray(Math.max(pos, buf.length - keep))
            return
          }
          pos = at + this.delimiter.length
          this.state = 'boundary'
          this.padding = 0
          break
        }
        case 'boundary': {
          // After `--boundary`: `--` closes the body, CRLF opens a part. Anything
          // else — including a longer boundary sharing this one as a prefix — is
          // malformed (RFC 2046 forbids the boundary inside a part's content).
          if (buf.length - pos < 2) {
            this.carry = buf.subarray(pos)
            return
          }
          if (this.padding === 0 && buf[pos] === DASH && buf[pos + 1] === DASH) {
            this.state = 'epilogue'
            return
          }
          if (buf[pos] === SPACE || buf[pos] === TAB) {
            if (++this.padding > MAX_PADDING) throw malformed()
            pos += 1
            break
          }
          if (buf[pos] !== CR || buf[pos + 1] !== LF) throw malformed()
          pos += 2
          this.state = 'headers'
          this.header = EMPTY
          break
        }
        case 'headers': {
          const acc = this.header.length > 0 ? Buffer.concat([this.header, buf.subarray(pos)]) : buf.subarray(pos)
          let bodyStart: number
          let block: Buffer
          if (acc.length >= 2 && acc[0] === CR && acc[1] === LF) {
            block = EMPTY
            bodyStart = 2
          } else {
            const end = acc.indexOf(HEADER_END)
            if (end === -1) {
              if (acc.length > this.maxHeaderBytes) throw malformed('Multipart part headers are too large.')
              this.header = Buffer.from(acc) // own copy: `buf` may be the caller's chunk
              return
            }
            if (end > this.maxHeaderBytes) throw malformed('Multipart part headers are too large.')
            block = acc.subarray(0, end)
            bodyStart = end + HEADER_END.length
          }
          this.header = EMPTY
          this.handlers.onPartStart(parsePartHeaders(block))
          this.state = 'body'
          buf = acc.subarray(bodyStart)
          pos = 0
          break
        }
        case 'body': {
          const at = buf.indexOf(this.delimiter, pos)
          if (at === -1) {
            const safe = buf.length - keep
            if (safe > pos) this.handlers.onPartData(buf.subarray(pos, safe))
            this.carry = buf.subarray(Math.max(pos, safe))
            return
          }
          if (at > pos) this.handlers.onPartData(buf.subarray(pos, at))
          this.handlers.onPartEnd()
          pos = at + this.delimiter.length
          this.state = 'boundary'
          this.padding = 0
          break
        }
        default:
          return
      }
    }
  }

  /** Call when the source ends; throws unless the closing delimiter was seen. */
  end(): void {
    if (this.state !== 'epilogue') throw malformed('Upload stream ended unexpectedly.')
  }
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/

/** A header value's leading token (lower-cased) and its `;`-separated parameters. */
export interface ParsedHeaderValue {
  value: string
  params: Map<string, string>
}

/**
 * Parses `type; a=b; c="d \"e\""` (RFC 9110 parameters, quoted-strings with
 * backslash escapes, unless `backslashEscapes` is false). Throws on a repeated parameter — two `boundary=` or two
 * `filename=` values are an ambiguity an attacker picks the reading of — and
 * on anything that does not tokenise cleanly.
 */
export function parseHeaderValue(input: string, backslashEscapes = true): ParsedHeaderValue {
  let i = 0
  const n = input.length
  const skipWs = () => {
    while (i < n && (input[i] === ' ' || input[i] === '\t')) i++
  }
  skipWs()
  const start = i
  while (i < n && input[i] !== ';') i++
  const value = input.slice(start, i).trim().toLowerCase()
  const params = new Map<string, string>()
  while (i < n) {
    i++ // ';'
    skipWs()
    if (i >= n) break // tolerate a trailing ';'
    const nameStart = i
    while (i < n && input[i] !== '=' && input[i] !== ';') i++
    const name = input.slice(nameStart, i).trim().toLowerCase()
    if (!TOKEN.test(name) || input[i] !== '=') throw malformed()
    i++ // '='
    let paramValue: string
    if (input[i] === '"') {
      i++
      let out = ''
      for (;;) {
        if (i >= n) throw malformed()
        const c = input[i]!
        if (c === '"') {
          i++
          break
        }
        if (backslashEscapes && c === '\\' && i + 1 < n) {
          out += input[i + 1]
          i += 2
          continue
        }
        out += c
        i++
      }
      paramValue = out
      skipWs()
      if (i < n && input[i] !== ';') throw malformed()
    } else {
      const valueStart = i
      while (i < n && input[i] !== ';') i++
      paramValue = input.slice(valueStart, i).trim()
    }
    if (params.has(name)) throw malformed()
    params.set(name, paramValue)
  }
  return { value, params }
}

/** Decodes an RFC 8187 ext-value (`UTF-8''na%C3%AFve.txt`); `undefined` if unusable. */
function decodeExtValue(value: string): string | undefined {
  const match = /^([A-Za-z0-9!#$%&+^_`{}~-]+)'[A-Za-z0-9-]*'(.*)$/.exec(value)
  if (!match || match[1]!.toLowerCase() !== 'utf-8') return undefined
  try {
    return decodeURIComponent(match[2]!)
  } catch {
    return undefined
  }
}

function parsePartHeaders(block: Buffer): PartHeaders {
  if (block.length === 0) throw malformed()
  const lines = block.toString('utf8').split('\r\n')
  if (lines.length > MAX_PART_HEADERS) throw malformed('Multipart part headers are too large.')
  const headers = new Map<string, string>()
  for (const line of lines) {
    // Obsolete line folding is refused outright, as are bare CR/LF smuggled
    // inside a line — both are classic header-injection vectors.
    if (line.startsWith(' ') || line.startsWith('\t') || /[\r\n\0]/.test(line)) throw malformed()
    const colon = line.indexOf(':')
    if (colon <= 0) throw malformed()
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!TOKEN.test(name)) throw malformed()
    if (headers.has(name)) throw malformed()
    headers.set(name, line.slice(colon + 1).trim())
  }

  const disposition = headers.get('content-disposition')
  if (disposition === undefined) throw malformed()
  // Browsers (WHATWG multipart/form-data encoding) never backslash-escape in
  // these parameters — they percent-encode `"` — and old ones send Windows
  // paths (`C:\dir\a.png`) verbatim, so a backslash is a literal here.
  const parsed = parseHeaderValue(disposition, false)
  if (parsed.value !== 'form-data') throw malformed()
  const name = parsed.params.get('name')
  if (name === undefined || name === '') throw malformed()

  const encoding = headers.get('content-transfer-encoding')?.toLowerCase()
  if (encoding !== undefined && encoding !== 'binary' && encoding !== '8bit' && encoding !== '7bit') {
    throw malformed()
  }

  const part: PartHeaders = { name }
  const extended = parsed.params.get('filename*')
  const plain = parsed.params.get('filename')
  const filename = extended !== undefined ? (decodeExtValue(extended) ?? plain) : plain
  if (filename !== undefined) part.filename = filename

  const type = headers.get('content-type')
  if (type !== undefined) {
    const essence = parseHeaderValue(type).value
    if (!MEDIA_TYPE.test(essence)) throw malformed()
    part.contentType = essence
  }
  return part
}

/**
 * Validates a request `Content-Type` for a multipart upload and returns its
 * boundary. 415 when the media type is not `multipart/form-data`; 400 when the
 * boundary is missing, repeated, or outside RFC 2046's grammar (1–70 `bchars`,
 * not ending in a space).
 */
export function multipartBoundary(contentType: string | undefined): string {
  const unsupported = new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected a multipart/form-data body.')
  if (!contentType) throw unsupported
  let parsed: ParsedHeaderValue
  try {
    parsed = parseHeaderValue(contentType)
  } catch {
    if (!contentType.trim().toLowerCase().startsWith('multipart/form-data')) throw unsupported
    throw malformed('Invalid multipart boundary.')
  }
  if (parsed.value !== 'multipart/form-data') throw unsupported
  const boundary = parsed.params.get('boundary')
  if (boundary === undefined || !/^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/.test(boundary)) {
    throw malformed('Invalid multipart boundary.')
  }
  return boundary
}

// Bidirectional-override and zero-width formatting characters let a name like
// `invoice\u202Etxt.exe` display as `invoiceexe.txt`.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g

/** Longest sanitised filename, in UTF-8 bytes (a common filesystem limit). */
const MAX_FILENAME_BYTES = 255

/**
 * Reduces a client-supplied filename to a safe display basename: never a path.
 * Directories are stripped on both `/` and `\` (so `../../x` and `C:\x` become
 * `x`), a drive prefix is dropped, control/NUL and invisible bidi characters
 * are removed, trailing dots/spaces are trimmed, and the result is capped at
 * 255 UTF-8 bytes with the extension kept. Returns `'file'` when nothing
 * usable is left. Still only a label — never use it as a storage key.
 */
export function sanitizeFilename(raw: string): string {
  let name = raw.normalize('NFC').replace(CONTROL, '').replace(INVISIBLE, '')
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  name = name.replace(/^[A-Za-z]:/, '')
  name = name.trim().replace(/[. ]+$/, '')
  if (name === '' || name === '.' || name === '..') return 'file'
  if (Buffer.byteLength(name) > MAX_FILENAME_BYTES) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
    let stem = name.slice(0, name.length - ext.length)
    while (Buffer.byteLength(stem + ext) > MAX_FILENAME_BYTES) stem = [...stem].slice(0, -1).join('')
    name = stem + ext
  }
  return name
}
