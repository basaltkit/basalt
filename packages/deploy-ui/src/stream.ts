import { parseEvent, type DeployEvent, type DoneEvent, type HelloEvent } from '@basaltkit/deploy/protocol'

/**
 * Reading a `--json` stream from ssh's stdout (RFC 0009 §6.5): lines split on
 * `\n` with a 1 MiB cap; text before `hello` is foreign (a chatty `.bashrc`)
 * and kept as a diagnostic; after `hello` every line must pass `parseEvent`
 * with `seq` exactly one more than the last, and nothing may follow `done`.
 * Anything else ends the stream as corrupt — never skipped, never guessed.
 */

export const MAX_LINE_BYTES = 1024 * 1024
export const MAX_DIAGNOSTIC_BYTES = 64 * 1024

/** ANSI/VT sequences, C0/C1 controls but tab and newline, and bidi controls: text a terminal or a browser could misrender. */
export function sanitizeText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '')
}

export type StreamFailure =
  | { kind: 'corrupt'; message: string }
  | { kind: 'protocol-version'; message: string }

export interface ReaderOptions {
  /** `attach`: the outer stream wraps the run's events; both sequences are checked. */
  attach?: { fromSeq: number }
  onEvent?: (event: DeployEvent, known: boolean) => void
  /** A run event unwrapped from `attach` (its `seq` is the resume key). */
  onInner?: (event: DeployEvent, known: boolean) => void
  onDiagnostic?: (text: string) => void
}

/** Collects text up to a byte budget, counting what it drops. */
export class Diagnostics {
  readonly lines: string[] = []
  private bytes = 0
  dropped = 0
  constructor(private readonly budget = MAX_DIAGNOSTIC_BYTES) {}
  add(text: string): string | undefined {
    const clean = sanitizeText(text)
    const size = Buffer.byteLength(clean)
    if (this.bytes + size > this.budget) {
      this.dropped += size
      return undefined
    }
    this.bytes += size
    this.lines.push(clean)
    return clean
  }
}

export class ProtocolReader {
  hello?: HelloEvent
  done?: DoneEvent
  /** attach: the run's own `done`, unwrapped. */
  innerDone?: DoneEvent
  /** attach: the run's last seq seen. */
  lastInnerSeq?: number
  failure?: StreamFailure
  readonly diagnostics = new Diagnostics()
  private pending: Buffer = Buffer.alloc(0)
  private lineNo = 0
  private nextSeq = 0

  constructor(private readonly options: ReaderOptions = {}) {}

  /** False once the stream is corrupt: the caller stops reading (and ends the ssh). */
  push(chunk: Buffer): boolean {
    if (this.failure) return false
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    let newline: number
    while ((newline = this.pending.indexOf(0x0a)) !== -1) {
      if (newline > MAX_LINE_BYTES) return this.fail({ kind: 'corrupt', message: `a line longer than ${MAX_LINE_BYTES} bytes at line ${this.lineNo + 1}` })
      const line = this.pending.subarray(0, newline).toString('utf8')
      this.pending = this.pending.subarray(newline + 1)
      this.lineNo++
      if (!this.line(line)) return false
    }
    if (this.pending.length > MAX_LINE_BYTES) return this.fail({ kind: 'corrupt', message: `a line longer than ${MAX_LINE_BYTES} bytes at line ${this.lineNo + 1}` })
    return true
  }

  /** The end of stdout: a partial last line is foreign before `hello` and corrupt after it. */
  end(): void {
    if (this.failure || this.pending.length === 0) return
    const rest = this.pending.toString('utf8')
    this.pending = Buffer.alloc(0)
    if (!this.hello) this.foreign(rest)
    else this.fail({ kind: 'corrupt', message: `the output ends mid-line at line ${this.lineNo + 1}` })
  }

  private fail(failure: StreamFailure): false {
    this.failure = failure
    return false
  }

  private foreign(line: string): void {
    const text = this.diagnostics.add(line)
    if (text !== undefined) this.options.onDiagnostic?.(text)
  }

  private line(line: string): boolean {
    if (!this.hello) {
      const parsed = parseEvent(line)
      if (parsed.ok && parsed.value.type === 'hello' && parsed.value.seq === 0) {
        this.hello = parsed.value
        this.nextSeq = 1
        this.options.onEvent?.(parsed.value, true)
        return true
      }
      if (!parsed.ok && looksLikeHello(line)) {
        return this.fail({ kind: 'protocol-version', message: 'this server\'s @basaltkit/deploy does not speak protocol 1' })
      }
      // A login script's echo, a MOTD: data, never parsed further.
      this.foreign(line)
      return true
    }
    if (this.done) return this.fail({ kind: 'corrupt', message: `output after done at line ${this.lineNo}` })
    const parsed = parseEvent(line)
    if (!parsed.ok) return this.fail({ kind: 'corrupt', message: `the server's output is corrupt at line ${this.lineNo}: ${parsed.error}` })
    const event = parsed.value
    if (event.seq !== this.nextSeq) return this.fail({ kind: 'corrupt', message: `the server's output is corrupt at line ${this.lineNo}: seq ${event.seq}, expected ${this.nextSeq}` })
    this.nextSeq++
    if (event.type === 'done') this.done = event
    if (this.options.attach && event.type === 'event') {
      const inner = event.event
      const expected = this.lastInnerSeq === undefined ? this.options.attach.fromSeq : this.lastInnerSeq + 1
      if (this.innerDone) return this.fail({ kind: 'corrupt', message: `a run event after the run's done at line ${this.lineNo}` })
      if (inner.seq !== expected) return this.fail({ kind: 'corrupt', message: `the run's events are not continuous at line ${this.lineNo}: seq ${inner.seq}, expected ${expected}` })
      this.lastInnerSeq = inner.seq
      if (inner.type === 'done') this.innerDone = inner
      this.options.onInner?.(inner, parsed.known !== false)
      return true
    }
    this.options.onEvent?.(event, parsed.known !== false)
    return true
  }
}

/** A `hello` of a protocol this UI does not speak (another `v` or `protocol`). */
function looksLikeHello(line: string): boolean {
  try {
    const value = JSON.parse(line) as Record<string, unknown> | null
    return typeof value === 'object' && value !== null && value['type'] === 'hello' && value['tool'] === '@basaltkit/deploy'
  } catch {
    return false
  }
}
