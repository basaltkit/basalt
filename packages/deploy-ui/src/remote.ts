import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { DeployEvent, DoneEvent, ErrorEvent, HelloEvent } from '@basaltkit/deploy/protocol'
import type { CommandReply, Failure, StreamMessage } from './client/messages.js'
import { classifySshFailure, remoteCommand, sshArgs, type RemoteSpec } from './ssh.js'
import { Diagnostics, ProtocolReader } from './stream.js'
import type { Target } from './targets.js'

/**
 * One remote command over ssh, read through {@link ProtocolReader}: the
 * events, the result, the error and how it ended. Answers go on stdin, up
 * front, then stdin is closed and the buffer zero-filled.
 */

export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface SshRunner {
  /** `ssh`, `ssh.exe` or `--ssh=<path>` (a test: node). */
  program: string
  /** Arguments before ssh's own (a test: the fake ssh script). Empty in use. */
  prefix: readonly string[]
  spawn: Spawn
  /** The UI process's own environment, unchanged: nothing is added to it. */
  env: NodeJS.ProcessEnv
  /** Where ssh starts: the operator's home, never the directory the UI was started from (a cloned app). */
  cwd?: string
}

export interface ExecOptions {
  actor?: string
  /** The answer lines, sent on stdin and then zero-filled. */
  stdin?: Buffer
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (event: DeployEvent, known: boolean) => void
  onInner?: (event: DeployEvent, known: boolean) => void
  onDiagnostic?: (text: string) => void
}

export interface RemoteOutcome {
  hello?: HelloEvent
  error?: ErrorEvent
  result?: unknown
  done?: DoneEvent
  innerDone?: DoneEvent
  lastInnerSeq?: number
  failure?: Failure
  /** Foreign text before `hello`, then ssh's stderr. */
  diagnostics: string[]
  /** ssh's stderr alone, sanitised. */
  stderr: string[]
  sshExit: number | null
}

/** Failures that a retry cannot fix: the key, the host key, the server's setup, or a stream that lied. */
const PERMANENT = new Set(['ssh-missing', 'auth', 'passphrase', 'host-key', 'no-node', 'no-dir', 'no-deploy', 'corrupt', 'protocol-version', 'no-protocol', 'unsafe', 'cancelled'])
export const isPermanent = (failure: Failure) => PERMANENT.has(failure.code)

export async function execRemote(runner: SshRunner, target: Target, spec: RemoteSpec, options: ExecOptions = {}): Promise<RemoteOutcome> {
  const stdin = options.stdin
  let args: string[]
  try {
    args = [...runner.prefix, ...sshArgs(target, remoteCommand(target, spec, options.actor))]
  } catch (error) {
    stdin?.fill(0)
    return { failure: { code: 'unsafe', message: (error as Error).message }, diagnostics: [], stderr: [], sshExit: null }
  }
  let result: unknown
  let error: ErrorEvent | undefined
  const reader = new ProtocolReader({
    ...(spec.command === 'attach' ? { attach: { fromSeq: spec.fromSeq ?? 0 } } : {}),
    onEvent: (event, known) => {
      if (event.type === 'result') result = event.data
      if (event.type === 'error') error = event
      options.onEvent?.(event, known)
    },
    ...(options.onInner ? { onInner: options.onInner } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  })
  const stderr = new Diagnostics()
  let rawStderr = ''
  let timedOut = false
  let cancelled = false
  let spawnError: NodeJS.ErrnoException | undefined

  const exit = await new Promise<number | null>((resolve) => {
    let child: ChildProcess
    try {
      child = runner.spawn(runner.program, args, {
        shell: false,
        windowsHide: true,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: runner.env,
        ...(runner.cwd ? { cwd: runner.cwd } : {}),
      })
    } catch (caught) {
      spawnError = caught as NodeJS.ErrnoException
      stdin?.fill(0)
      resolve(null)
      return
    }
    const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; stop() }, options.timeoutMs) : undefined
    const onAbort = () => { cancelled = true; stop() }
    if (options.signal?.aborted) onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (caught: NodeJS.ErrnoException) => { spawnError = caught })
    child.stdout?.on('data', (chunk: Buffer) => { if (!reader.push(chunk)) stop() })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (rawStderr.length < 64 * 1024) rawStderr += chunk.toString('utf8')
      stderr.add(chunk.toString('utf8'))
    })
    if (stdin && child.stdin) {
      // The reader may be gone already (a refused connection): EPIPE is not an error of ours.
      child.stdin.on('error', () => undefined)
      child.stdin.end(stdin, () => stdin.fill(0))
    } else stdin?.fill(0)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      stdin?.fill(0)
      resolve(code)
    })
  })

  reader.end()
  const stderrLines = stderr.lines.filter((line) => line.trim() !== '')
  if (stderr.dropped > 0) stderrLines.push(`(${stderr.dropped} more bytes of stderr not shown)`)
  const diagnostics = [...reader.diagnostics.lines, ...stderrLines]
  const outcome: RemoteOutcome = {
    ...(reader.hello ? { hello: reader.hello } : {}),
    ...(error ? { error } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(reader.done ? { done: reader.done } : {}),
    ...(reader.innerDone ? { innerDone: reader.innerDone } : {}),
    ...(reader.lastInnerSeq !== undefined ? { lastInnerSeq: reader.lastInnerSeq } : {}),
    diagnostics,
    stderr: stderrLines,
    sshExit: exit,
  }
  const failure = describeFailure(reader, { spawnError, timedOut, cancelled, exit, stderr: rawStderr, destination: target.ssh })
  if (failure) outcome.failure = failure
  return outcome
}

function describeFailure(reader: ProtocolReader, how: { spawnError: NodeJS.ErrnoException | undefined; timedOut: boolean; cancelled: boolean; exit: number | null; stderr: string; destination: string }): Failure | undefined {
  if (how.spawnError) {
    return how.spawnError.code === 'ENOENT'
      ? { code: 'ssh-missing', message: 'no ssh client was found', hint: 'install OpenSSH (on Windows: the OpenSSH Client optional feature), or pass --ssh=<absolute path>' }
      : { code: 'ssh', message: `ssh could not start: ${how.spawnError.message}` }
  }
  if (reader.failure && reader.failure.kind !== 'truncated') return { code: reader.failure.kind, message: reader.failure.message }
  if (how.cancelled) return { code: 'cancelled', message: 'stopped by the UI' }
  if (how.timedOut) return { code: 'timeout', message: 'the command took too long and was stopped' }
  if (reader.done) return undefined
  const ssh = classifySshFailure(how.exit, how.stderr, how.destination)
  if (!reader.hello) {
    return ssh ?? {
      code: 'no-protocol',
      message: 'no protocol output from the server',
      hint: 'is the account\'s login shell POSIX (sh, bash, zsh)? Does the app\'s @basaltkit/deploy speak protocol 1 (the release with RFC 0008)? Upgrade it in the app and deploy once from a terminal',
    }
  }
  const cut = reader.failure ? `${reader.failure.message}, ` : ''
  return { code: 'abnormal', message: `the output ended without done (${cut}exit ${how.exit ?? 'by signal'}) — never a success`, ...(ssh ? { hint: ssh.message } : {}) }
}

/** The reply of a collected command: it succeeded only with `done` exit 0 and no failure. */
export function toReply(outcome: RemoteOutcome): CommandReply {
  return {
    ok: !outcome.failure && outcome.done?.exitCode === 0,
    ...(outcome.hello ? { hello: outcome.hello } : {}),
    ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.done ? { exitCode: outcome.done.exitCode } : {}),
    ...(outcome.failure ? { failure: outcome.failure } : {}),
    diagnostics: outcome.diagnostics,
  }
}

export interface FollowOptions {
  signal: AbortSignal
  actor?: string
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  /** How long to keep reconnecting without progress (RFC 0009 §7: 10 minutes). */
  windowMs?: number
}

export const RECONNECT_FIRST_MS = 1000
export const RECONNECT_MAX_MS = 30_000
export const RECONNECT_WINDOW_MS = 10 * 60_000

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  signal.addEventListener('abort', done, { once: true })
})

/**
 * `attach --follow` that survives a dropped connection: when ssh ends without
 * the run's `done`, it attaches again from the last run seq + 1 (1 s, 2 s, 4 s
 * … 30 s, for up to 10 minutes without progress). The page never sees a
 * duplicate or a gap: the reader checks the run's sequence on every attach.
 */
export async function follow(runner: SshRunner, target: Target, runId: string, fromSeq: number, emit: (message: StreamMessage) => void, options: FollowOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? RECONNECT_WINDOW_MS
  let next = fromSeq
  let delay = RECONNECT_FIRST_MS
  let since = now()
  let greeted = false
  emit({ kind: 'state', state: 'connecting' })
  for (;;) {
    if (options.signal.aborted) {
      emit({ kind: 'state', state: 'ended', code: 'stopped', reason: 'the UI stopped watching; the run goes on on the server' })
      return
    }
    let progressed = false
    const outcome = await execRemote(runner, target, { command: 'attach', runId, fromSeq: next, follow: true }, {
      signal: options.signal,
      onEvent: (event) => {
        if (event.type === 'hello' && !greeted) { greeted = true; emit({ kind: 'hello', hello: event }) }
      },
      onInner: (event, known) => {
        next = event.seq + 1
        progressed = true
        emit({ kind: 'event', event, known })
      },
      onDiagnostic: (text) => emit({ kind: 'diagnostic', text }),
    })
    if (outcome.innerDone) {
      emit({ kind: 'state', state: 'ended', exitCode: outcome.innerDone.exitCode })
      return
    }
    if (outcome.error) {
      emit({ kind: 'state', state: 'ended', code: outcome.error.code, reason: outcome.error.message, ...(outcome.error.hint ? { hint: outcome.error.hint } : {}) })
      return
    }
    if (outcome.done && !outcome.failure) {
      // Attach ended cleanly without the run's `done` in this window: the run's
      // `done` came before `fromSeq` (RFC 0008 §8.4 — attach's exit code is the
      // run's). The run has finished; reconnecting would never see more.
      emit({ kind: 'state', state: 'ended', exitCode: outcome.done.exitCode, reason: 'the run had already finished' })
      return
    }
    const failure = outcome.failure ?? { code: 'abnormal', message: 'attach ended without the run\'s done' }
    if (isPermanent(failure)) {
      if (failure.code === 'cancelled') continue
      for (const text of outcome.stderr) emit({ kind: 'diagnostic', text })
      emit({ kind: 'state', state: 'ended', code: failure.code, reason: failure.message, ...(failure.hint ? { hint: failure.hint } : {}) })
      return
    }
    if (progressed) { since = now(); delay = RECONNECT_FIRST_MS }
    if (now() - since >= windowMs) {
      emit({ kind: 'state', state: 'ended', code: 'disconnected', reason: `the connection kept dropping (${failure.message}); the run goes on on the server`, hint: 're-attach when the network is back' })
      return
    }
    emit({ kind: 'state', state: 'reconnecting', code: failure.code, reason: failure.message, retryInMs: delay })
    await sleep(delay, options.signal)
    delay = Math.min(delay * 2, RECONNECT_MAX_MS)
  }
}
