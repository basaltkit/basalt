import type { DeployConfig } from './config.js'
import { formatFinding, type Finding } from './context.js'
import { envValues, parseEnv } from './dotenv.js'
import type { LogHandle, Output } from './host.js'
import { SENSITIVE } from './init.js'
import { isStepId, type DeployEvent, type EventBody, type LogLevel, type ResultCommand, type ResultPayloads, type StepId, type StepStatus } from './protocol.js'

/**
 * One reporter, two renderers (RFC 0008 §5). Every command reports what it
 * does through {@link Output}; the CLI reports its own beginning and end
 * (`hello`, `error`, `done`) as events through a {@link Reporter}. A terminal
 * renders those events as the text it always printed ({@link humanReporter});
 * `--json` writes them as NDJSON ({@link EventWriter}), with the pipeline's
 * Output turned into events by {@link eventOutput}.
 */
export interface Reporter {
  emit(event: EventBody): void
}

/** Events as the terminal has always shown them (nothing new is printed). */
export function humanReporter(out: Output): Reporter {
  return {
    emit(event) {
      switch (event.type) {
        case 'step-start': out.step(event.title, event.id); return
        case 'log': out[event.level](event.text); return
        case 'finding':
          if (event.level === 'error') out.error(formatFinding(event))
          else out.warn(formatFinding(event))
          return
        case 'error': out.error(event.message); return
        default: return
      }
    },
  }
}

/**
 * The pipeline's Output as events: steps begin and end, lines are `log`
 * events of the step that runs, findings and results are structured.
 */
export type EventOutput = Output & Required<Pick<Output, 'stepEnd' | 'finding' | 'result'>> & { readonly current: StepId | undefined }

export function eventOutput(reporter: Reporter): EventOutput {
  let current: StepId | undefined
  const log = (level: LogLevel) => (text: string) => {
    reporter.emit({ type: 'log', stream: 'tool', level, text: sanitize(text, true), redacted: false, ...(current ? { step: current } : {}) })
  }
  return {
    get current() { return current },
    step(title, id) {
      const step = id ?? (isStepId(title) ? title : undefined)
      if (!step) { log('info')(title); return }
      current = step
      reporter.emit({ type: 'step-start', id: step, title })
    },
    info: log('info'),
    ok: log('ok'),
    warn: log('warn'),
    error: log('error'),
    stepEnd(id: StepId, status: StepStatus, durationMs: number) {
      reporter.emit({ type: 'step-end', id, status, durationMs: Math.max(0, Math.round(durationMs)) })
      if (current === id) current = undefined
    },
    finding(finding: Finding) {
      reporter.emit({ type: 'finding', id: finding.id, level: finding.level, message: finding.message, ...(finding.fix ? { fix: finding.fix } : {}) })
    },
    result<C extends ResultCommand>(command: C, data: ResultPayloads[C]) {
      reporter.emit({ type: 'result', command, data } as EventBody)
    },
  }
}

// ── text from outside: children, the config ──────────────────────────────

/** CSI, OSC, DCS/SOS/PM/APC, then any other escape (`ESC c`, `ESC ( B`). */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]|\u009b[0-?]*[ -/]*[@-~]/g
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const CONTROLS_AND_NEWLINE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g

/** Text without terminal escape sequences or control characters (tab kept; newlines only when asked). */
export function sanitize(text: string, keepNewlines = false): string {
  return text.replace(ESCAPES, '').replace(keepNewlines ? CONTROLS : CONTROLS_AND_NEWLINE, '')
}

export const MAX_LINE_BYTES = 8 * 1024

/** At most {@link MAX_LINE_BYTES} of UTF-8, never half a character. */
export function truncate(text: string, max = MAX_LINE_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= max) return { text, truncated: false }
  return { text: bytes.subarray(0, max).toString('utf8').replace(/�+$/, ''), truncated: true }
}

/**
 * Splits a stream of text into lines: `\n`, `\r\n`, and a lone `\r` (a
 * progress bar redrawing its line). A line longer than `maxPending` without
 * an end is cut there, so memory stays bounded.
 */
export class LineSplitter {
  private pending = ''
  constructor(private readonly maxPending = 64 * 1024) {}

  push(text: string): string[] {
    this.pending += text
    const lines: string[] = []
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.pending)
      if (!match) break
      // A '\r' at the very end may be the first half of '\r\n'.
      if (match[0] === '\r' && match.index === this.pending.length - 1) break
      lines.push(this.pending.slice(0, match.index))
      this.pending = this.pending.slice(match.index + match[0].length)
    }
    while (this.pending.length > this.maxPending) {
      lines.push(this.pending.slice(0, this.maxPending))
      this.pending = this.pending.slice(this.maxPending)
    }
    return lines
  }

  end(): string[] {
    const rest = this.pending.replace(/\r$/, '')
    this.pending = ''
    return rest ? [rest] : []
  }
}

// ── the redactor (RFC 0008 §6.2) ───────────────────────────────────────────

/** Shorter values are not matched — they would shred ordinary text; a `secret-short` warning names them. */
export const MIN_REDACTED_LENGTH = 6

/**
 * The secret values this command knows, replaced by `[redacted:KEY]` in every
 * string of every event — raw and URL-encoded, longest first. Only grows.
 */
export class Redactor {
  private readonly needles = new Map<string, string>()
  private sorted: Array<[string, string]> | undefined
  /** Keys whose value is too short to be matched. */
  readonly short = new Set<string>()

  /** `short` when the value is too short to match; `added` or `known` otherwise. */
  add(key: string, value: string): 'added' | 'known' | 'short' | 'empty' {
    if (value === '') return 'empty'
    if (value.length < MIN_REDACTED_LENGTH) {
      if (this.short.has(key)) return 'known'
      this.short.add(key)
      return 'short'
    }
    let added = false
    for (const form of new Set([value, encodeURIComponent(value)])) {
      if (form.length < MIN_REDACTED_LENGTH || this.needles.has(form)) continue
      this.needles.set(form, key)
      added = true
    }
    if (added) this.sorted = undefined
    return added ? 'added' : 'known'
  }

  get size(): number {
    return this.needles.size
  }

  apply(text: string): { text: string; hit: boolean } {
    if (this.needles.size === 0 || text.length < MIN_REDACTED_LENGTH) return { text, hit: false }
    this.sorted ??= [...this.needles].sort((a, b) => b[0].length - a[0].length)
    let out = text
    let hit = false
    for (const [needle, key] of this.sorted) {
      if (!out.includes(needle)) continue
      out = out.split(needle).join(`[redacted:${key}]`)
      hit = true
    }
    return { text: out, hit }
  }
}

const INFRA_SECRETS = /^BASALT_(PG|REDIS|MINIO)_/

/** Whether the value of `key` is a secret for this config: generated, asked as a secret, or named like one. */
export function isSecretKey(key: string, config?: DeployConfig): boolean {
  if (SENSITIVE.test(key) || INFRA_SECRETS.test(key)) return true
  if (!config) return false
  if (config.env.generate && key in config.env.generate) return true
  const question = config.env.ask?.[key as keyof typeof config.env.ask] as { secret?: boolean } | undefined
  return question?.secret === true
}

/** The password inside a `scheme://user:password@…` value, as written and decoded. */
export function urlPasswords(value: string): string[] {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/@:]*:([^/@]+)@/i.exec(value)
  if (!match) return []
  const raw = match[1] as string
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // Not valid percent-encoding: the raw form is what can appear.
  }
  return [...new Set([raw, decoded])]
}

/**
 * Learns the secrets of key/value pairs (a `.env`, a child's environment).
 * Returns the keys that are too short to be redacted, the first time each is seen.
 */
export function learnSecrets(redactor: Redactor, pairs: Iterable<[string, string]>, config?: DeployConfig): string[] {
  const short: string[] = []
  const note = (key: string, value: string) => { if (redactor.add(key, value) === 'short') short.push(key) }
  for (const [key, value] of pairs) {
    if (isSecretKey(key, config)) note(key, value)
    for (const password of urlPasswords(value)) note(key, password)
  }
  return short
}

/** {@link learnSecrets} over the text of a `.env`. */
export const learnEnvText = (redactor: Redactor, text: string, config?: DeployConfig) => learnSecrets(redactor, envValues(parseEnv(text)), config)

// ── the writer (RFC 0008 §5.2) ─────────────────────────────────────────────

/** A run log takes no more `log` events past this size (RFC 0008 §8.7). */
export const RUN_LOG_CAP = 64 * 1024 * 1024
const CAP_NOTICE = 'run log cap reached: further output lines dropped'

export interface WriterOptions {
  now: () => Date
  /** Where events go first: the real stdout (captured before anything replaced it). */
  stdout: (line: string) => void
  redactor: Redactor
  runId?: string
  /** stdout is the run log (a detached child): the cap applies to it. */
  stdoutIsRunLog?: boolean
  /** Keep the events in memory until a run log is attached (they are written to it first). */
  expectRunLog?: boolean
  cap?: number
  /** One plain line when an event cannot be written (stderr). */
  onFailure?: (message: string) => void
}

/**
 * The one place events are serialised: it assigns `seq` and `ts`, redacts
 * every string field BEFORE `JSON.stringify` (a secret with `"` or `\` would
 * be escaped in the JSON and missed afterwards), then writes the line to
 * stdout and to the run log.
 */
export class EventWriter implements Reporter {
  private seq = 0
  private logBytes = 0
  private capped = false
  private log: LogHandle | undefined
  private backlog: string[] | undefined
  /** Every event written, in order (what `done` and the detaching parent look at). */
  readonly last: { error?: DeployEvent; result?: DeployEvent; done?: DeployEvent } = {}

  constructor(private readonly options: WriterOptions) {
    if (options.expectRunLog) this.backlog = []
  }

  get runId(): string | undefined {
    return this.options.runId
  }

  get nextSeq(): number {
    return this.seq
  }

  emit(body: EventBody): void {
    this.write(body, false)
  }

  private write(body: EventBody, notice: boolean): void {
    let line: string
    let event: DeployEvent
    const capApplies = Boolean(this.log || this.backlog || this.options.stdoutIsRunLog)
    try {
      const { value, hit } = redactDeep(body, this.options.redactor)
      const redacted = value as Record<string, unknown>
      if (redacted['type'] === 'log') redacted['redacted'] = hit || redacted['redacted'] === true
      event = {
        v: 1,
        ts: this.options.now().toISOString(),
        seq: this.seq,
        ...(this.options.runId ? { runId: this.options.runId } : {}),
        ...(hit ? { redacted: true as const } : {}),
        ...redacted,
      } as DeployEvent
      line = `${JSON.stringify(event)}\n`
    } catch (error) {
      this.options.onFailure?.(`basalt-deploy: an event could not be written: ${(error as Error).message}`)
      return
    }
    const bytes = Buffer.byteLength(line)
    if (capApplies && body.type === 'log' && !notice) {
      if (this.capped) return
      if (this.logBytes + bytes > (this.options.cap ?? RUN_LOG_CAP)) {
        // Dropped lines take no seq: the stream stays contiguous (RFC 0008 §4.5).
        this.capped = true
        this.write({ type: 'log', stream: 'tool', level: 'warn', text: CAP_NOTICE, redacted: false }, true)
        return
      }
    }
    this.seq++
    if (capApplies) this.logBytes += bytes
    if (event.type === 'error') this.last.error = event
    if (event.type === 'result') this.last.result = event
    if (event.type === 'done') this.last.done = event
    this.options.stdout(line)
    if (this.log) this.appendLog(line)
    else this.backlog?.push(line)
  }

  /** Writes what came before, then every event, to the run log. */
  attachLog(log: LogHandle): void {
    this.log = log
    for (const line of this.backlog ?? []) this.appendLog(line)
    this.backlog = undefined
  }

  /** No run log for this command after all. */
  dropBacklog(): void {
    this.backlog = undefined
    if (!this.log) this.logBytes = 0
  }

  close(): void {
    try {
      this.log?.close()
    } catch {
      // Closing a log that is gone changes nothing.
    }
    this.log = undefined
  }

  private appendLog(line: string): void {
    try {
      this.log?.append(line)
    } catch (error) {
      // The run log failing (disk full) must not stop the deploy; stdout still has every event.
      this.log = undefined
      this.options.onFailure?.(`basalt-deploy: the run log could not be written: ${(error as Error).message}`)
    }
  }
}

function redactDeep(value: unknown, redactor: Redactor): { value: unknown; hit: boolean } {
  if (typeof value === 'string') {
    const { text, hit } = redactor.apply(value)
    return { value: text, hit }
  }
  if (Array.isArray(value)) {
    let hit = false
    const out = value.map((item) => {
      const r = redactDeep(item, redactor)
      hit ||= r.hit
      return r.value
    })
    return { value: out, hit }
  }
  if (value !== null && typeof value === 'object') {
    let hit = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const r = redactDeep(item, redactor)
      hit ||= r.hit
      out[key] = r.value
    }
    return { value: out, hit }
  }
  return { value, hit: false }
}

/**
 * Text written to the deploy's stdout by code that is not this tool's — the
 * config's `console.log` — as `log{stream:'foreign'}` events (RFC 0008 §5.4):
 * split, sanitised, cut, never interpreted.
 */
export function foreignSink(reporter: Reporter, step: () => StepId | undefined): (text: string) => void {
  const lines = new LineSplitter()
  return (text) => {
    for (const line of lines.push(text)) emitLine(reporter, 'foreign', 'warn', line, step())
  }
}

/** A child's output as `log{stream:'child'}` events: stdout `info`, stderr `warn`. */
export function childSink(reporter: Reporter, source: string, step: StepId | undefined): { push(text: string, stream: 'stdout' | 'stderr'): void; end(): void } {
  const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() }
  const level = (stream: 'stdout' | 'stderr'): LogLevel => (stream === 'stdout' ? 'info' : 'warn')
  return {
    push(text, stream) {
      for (const line of splitters[stream].push(text)) emitLine(reporter, 'child', level(stream), line, step, source)
    },
    end() {
      for (const stream of ['stdout', 'stderr'] as const) {
        for (const line of splitters[stream].end()) emitLine(reporter, 'child', level(stream), line, step, source)
      }
    },
  }
}

function emitLine(reporter: Reporter, stream: 'child' | 'foreign', level: LogLevel, raw: string, step: StepId | undefined, source?: string): void {
  const clean = sanitize(raw)
  if (clean.trim() === '') return
  const { text, truncated } = truncate(clean)
  reporter.emit({
    type: 'log', stream, level, text, redacted: false,
    ...(step ? { step } : {}),
    ...(source ? { source } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  })
}
