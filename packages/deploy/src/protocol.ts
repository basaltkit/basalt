/**
 * The machine protocol of `basalt-deploy` (RFC 0008): the NDJSON events a
 * command writes under `--json`, the answer lines `--answers=stdin` reads,
 * and the parsers for both.
 *
 * This module is pure: types, constants and two parsers, no Node API and no
 * import that runs code. A program that drives the CLI (the phase-2 local UI)
 * imports it as `@basaltkit/deploy/protocol` without loading the CLI.
 */

import type { Finding } from './context.js'
import type { InstallPlan } from './install-plan.js'
import type { LockHolder } from './lock.js'
import type { Hold, Release } from './state.js'

/** The protocol version: `--json` and `--json=1`. */
export const PROTOCOL_VERSION = 1

/** The steps a command reports, a closed set (`step-start`/`step-end`). */
export const STEP_IDS = [
  'lock', 'preflight', 'fetch', 'env', 'infra', 'build', 'validate', 'backup', 'migrate',
  'release', 'health', 'verify', 'record', 'restore', 'plan', 'check',
] as const
export type StepId = typeof STEP_IDS[number]

export const ERROR_CODES = [
  'locked', 'aborted', 'config', 'refused-root', 'preflight', 'held', 'release-failed', 'failed',
  'answer-missing', 'answer-invalid', 'answer-unknown', 'answer-timeout',
  'protocol', 'protocol-version', 'usage', 'unsupported',
  'not-found', 'detach-unconfirmed', 'run-vanished', 'unexpected',
] as const
export type ErrorCode = typeof ERROR_CODES[number]

export const EVENT_TYPES = ['hello', 'step-start', 'step-end', 'log', 'finding', 'prompt', 'result', 'error', 'done', 'event'] as const
export type EventType = typeof EVENT_TYPES[number]

/** `<UTC yyyymmddThhmmssZ>-<12 hex>`: the id of a run and the name of its log (`<id>.ndjson`). */
export const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/

export const isStepId = (value: unknown): value is StepId => typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value)
export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)

export interface Envelope {
  v: 1
  /** ISO-8601 UTC with milliseconds. */
  ts: string
  /** 0, 1, 2, … per event stream: strictly +1, no gaps. */
  seq: number
  /** Set when the command writes a run log (run, env, rollback). */
  runId?: string
  /** True when the redactor replaced something in this event. */
  redacted?: true
}

export interface HelloEvent extends Envelope {
  type: 'hello'
  tool: '@basaltkit/deploy'
  version: string
  protocol: 1
  command: string
  pid: number
  host: string
  detached?: true
}

export interface StepStartEvent extends Envelope {
  type: 'step-start'
  id: StepId
  title: string
}

export type StepStatus = 'ok' | 'failed' | 'skipped' | 'aborted'

export interface StepEndEvent extends Envelope {
  type: 'step-end'
  id: StepId
  status: StepStatus
  durationMs: number
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error'

export interface LogEvent extends Omit<Envelope, 'redacted'> {
  type: 'log'
  /** `tool`: this tool's own lines; `child`: a line a child process printed; `foreign`: a stdout write by deploy.config.ts. */
  stream: 'tool' | 'child' | 'foreign'
  level: LogLevel
  /** Data, never instructions: render as plain text. */
  text: string
  /** Whether the redactor replaced something in this event. */
  redacted: boolean
  step?: StepId
  /** The child's command basename (`pnpm`, `docker`). */
  source?: string
  truncated?: true
}

export interface FindingEvent extends Envelope, Finding {
  type: 'finding'
}

/** A question as `plan --json` lists it and as a `prompt` asks it — never with a value. */
export interface PromptDescriptor {
  /** `env.<KEY>`: what an answer line names. */
  id: string
  kind: 'text' | 'secret' | 'confirm' | 'choice'
  message: string
  key?: string
  optional: boolean
  /** `text` only — a secret never carries one. */
  default?: string
  choices?: string[]
}

export interface PromptEvent extends Envelope, PromptDescriptor {
  type: 'prompt'
  attempt: number
}

export interface StatusResult {
  app: string
  stateDir: string
  lock: null | { holder?: LockHolder; stale: boolean; corrupt: boolean }
  activeRun?: { runId: string; pid: number; command: string; actor: string; startedAt: string; alive: boolean }
  lastRun?: { runId: string; command: string; exitCode?: number; complete: boolean; endedAt?: string }
  hold: Hold | null
  /** The last 10, newest first. */
  releases: Release[]
  process: { kind: 'pm2'; name: string; status?: string; pid?: number; running: boolean } | { kind: 'compose'; lines: string[] }
}

export interface CheckResult {
  file: string
  app: string
  runtime: 'pm2' | 'compose'
  proxy?: string
  types: 'ok' | 'failed' | 'not-typescript' | 'no-tsc'
}

export interface PlanResult {
  findings: Finding[]
  /** The lines `plan` prints, split at the first ': '. */
  lines: Array<{ step: string; text: string }>
  /** What `env`/`run` would ask now: send the answers with `--answers=stdin`. */
  questions: PromptDescriptor[]
  /** `plan` exits 1. */
  blocking: boolean
}

export interface RunResult {
  sha: string
  previous: string
  status: Release['status']
  migrations: string[]
  backup?: string
  url?: string
  heldOverride?: true
  /** Why it did not end `ok` (a key or a step, never a value). */
  note?: string
}

export interface RollbackResult {
  from: string
  to: string
  status: 'ok' | 'rollback-unhealthy'
  held: string
}

export interface EnvResult {
  file: string
  changes: Array<{ kind: 'set' | 'remove'; key: string; reason: string }>
  port?: number
}

export interface DetachResult {
  runId: string
  pid: number
  log: string
}

export interface CancelResult {
  runId: string
  pid: number
  signal: 'SIGTERM'
  second: boolean
}

export interface InstallPlanResult {
  plan: InstallPlan
  path?: string
  rootCommand: string
}

export interface ResultPayloads {
  status: StatusResult
  check: CheckResult
  plan: PlanResult
  run: RunResult | DetachResult
  rollback: RollbackResult | DetachResult
  env: EnvResult
  cancel: CancelResult
  'install-plan': InstallPlanResult
}
export type ResultCommand = keyof ResultPayloads

export type ResultEvent = Envelope & { type: 'result' } & { [C in ResultCommand]: { command: C; data: ResultPayloads[C] } }[ResultCommand]

export interface ErrorEvent extends Envelope {
  type: 'error'
  code: ErrorCode
  message: string
  hint?: string
  /** `locked` only: who holds the lock. */
  holder?: LockHolder
  /** The blocking findings (`preflight`). */
  findings?: Finding[]
}

export interface DoneEvent extends Envelope {
  type: 'done'
  exitCode: number
}

/** `attach`: one event of the run, as the run wrote it (`event.seq` is the resume key). */
export interface AttachedEvent extends Envelope {
  type: 'event'
  event: DeployEvent
}

export type DeployEvent =
  | HelloEvent | StepStartEvent | StepEndEvent | LogEvent | FindingEvent | PromptEvent
  | ResultEvent | ErrorEvent | DoneEvent | AttachedEvent

/** What the writer sets (`redacted` too, which a body may leave out). */
type EnvelopeKey = 'v' | 'ts' | 'seq' | 'runId'
type Body<E> = E extends unknown ? Omit<E, EnvelopeKey> : never
/** An event as a command emits it; the writer adds the envelope. */
export type EventBody = Body<DeployEvent>

// ── parsing ────────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const optional = (value: unknown, check: (v: unknown) => boolean) => value === undefined || check(value)
const LEVELS = ['info', 'ok', 'warn', 'error']
const STATUSES = ['ok', 'failed', 'skipped', 'aborted']

function findingShape(e: Record<string, unknown>): boolean {
  return isString(e['id']) && (e['level'] === 'error' || e['level'] === 'warning') && isString(e['message']) && optional(e['fix'], isString)
}

/** The fields each known type must have, with their types. Unknown fields are allowed (additive within v1). */
const SHAPES: Record<EventType, (e: Record<string, unknown>) => boolean> = {
  hello: (e) => e['tool'] === '@basaltkit/deploy' && isString(e['version']) && e['protocol'] === 1 && isString(e['command']) && isCount(e['pid']) && isString(e['host']),
  'step-start': (e) => isStepId(e['id']) && isString(e['title']),
  'step-end': (e) => isStepId(e['id']) && STATUSES.includes(e['status'] as string) && isCount(e['durationMs']),
  log: (e) => ['tool', 'child', 'foreign'].includes(e['stream'] as string) && LEVELS.includes(e['level'] as string) && isString(e['text'])
    && typeof e['redacted'] === 'boolean' && optional(e['step'], isStepId) && optional(e['source'], isString),
  finding: findingShape,
  prompt: (e) => isString(e['id']) && ['text', 'secret', 'confirm', 'choice'].includes(e['kind'] as string) && isString(e['message'])
    && typeof e['optional'] === 'boolean' && isCount(e['attempt']) && (e['kind'] !== 'secret' || e['default'] === undefined),
  result: (e) => isString(e['command']) && isObject(e['data']),
  error: (e) => isErrorCode(e['code']) && isString(e['message']) && optional(e['hint'], isString)
    && optional(e['findings'], (f) => Array.isArray(f) && f.every((x) => isObject(x) && findingShape(x))),
  done: (e) => isCount(e['exitCode']),
  event: (e) => isObject(e['event']) && checkEvent(e['event'], false).ok,
}

function checkEvent(value: unknown, allowWrapper: boolean): Parsed<DeployEvent> {
  if (!isObject(value)) return { ok: false, error: 'not a JSON object' }
  if (value['v'] !== PROTOCOL_VERSION) return { ok: false, error: `v is ${JSON.stringify(value['v'])}, not ${PROTOCOL_VERSION}` }
  if (!isString(value['type'])) return { ok: false, error: 'no type' }
  if (!isString(value['ts'])) return { ok: false, error: 'no ts' }
  if (!isCount(value['seq'])) return { ok: false, error: 'seq is not a whole number' }
  if (!optional(value['runId'], (r) => isString(r) && RUN_ID.test(r))) return { ok: false, error: 'runId is malformed' }
  // `redacted` is `true` or absent — except in a log event, where it is always a boolean.
  if (value['type'] !== 'log' && !optional(value['redacted'], (r) => r === true)) return { ok: false, error: 'redacted is not true' }
  const type = value['type'] as EventType
  const shape = SHAPES[type] as ((e: Record<string, unknown>) => boolean) | undefined
  // A type this reader does not know: valid, skipped by the caller (additive within v1).
  if (!shape) return { ok: true, value: value as unknown as DeployEvent }
  // An attached event never nests another one.
  if (!allowWrapper && type === 'event') return { ok: false, error: 'nested event' }
  if (!shape(value)) return { ok: false, error: `malformed ${type} event` }
  return { ok: true, value: value as unknown as DeployEvent }
}

/**
 * One NDJSON line of `--json` output, checked: the envelope, the version and
 * the fields of each known type. A line that does not pass is not an event —
 * a reader treats the stream as corrupt and stops. A type it does not know is
 * returned as is (`known: false`), to be skipped.
 */
export function parseEvent(line: string): Parsed<DeployEvent> & { known?: boolean } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  const checked = checkEvent(value, true)
  if (!checked.ok) return checked
  return { ...checked, known: (EVENT_TYPES as readonly string[]).includes(checked.value.type) }
}

// ── answers (--answers=stdin) ──────────────────────────────────────────────

export interface AnswerLine {
  v: 1
  type: 'answer'
  /** `env.<KEY>`. */
  id: string
  value: string
}

/** Per line, and in all. */
export const MAX_ANSWER_LINE_BYTES = 64 * 1024
export const MAX_ANSWER_LINES = 256
export const ANSWER_ID = /^env\.[A-Z_][A-Z0-9_]*$/

/**
 * One answer line, strictly: `v` 1, `type` `answer`, an `env.<KEY>` id and a
 * string value without NUL. Only these fields are read; others are ignored.
 * The error never quotes the value.
 */
export function parseAnswerLine(line: string): Parsed<AnswerLine> {
  if (new TextEncoder().encode(line).length > MAX_ANSWER_LINE_BYTES) return { ok: false, error: `an answer line is larger than ${MAX_ANSWER_LINE_BYTES} bytes` }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, error: 'an answer line is not JSON' }
  }
  if (!isObject(value)) return { ok: false, error: 'an answer line is not a JSON object' }
  if (value['v'] !== PROTOCOL_VERSION) return { ok: false, error: `an answer line has v ${JSON.stringify(value['v']) ?? 'missing'}, not ${PROTOCOL_VERSION}` }
  if (value['type'] !== 'answer') return { ok: false, error: 'an answer line\'s type is not "answer"' }
  const id = value['id']
  if (!isString(id) || !ANSWER_ID.test(id)) return { ok: false, error: 'an answer line\'s id is not env.<KEY>' }
  const answer = value['value']
  if (!isString(answer)) return { ok: false, error: `the answer for ${id} is not a string` }
  if (answer.includes('\u0000')) return { ok: false, error: `the answer for ${id} contains NUL` }
  return { ok: true, value: { v: 1, type: 'answer', id, value: answer } }
}
