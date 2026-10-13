import { join } from 'node:path'
import { DeployError } from './context.js'
import type { FileRange, Host, LogHandle } from './host.js'
import { readLock, type LockState } from './lock.js'
import { parseEvent, RUN_ID, type DeployEvent, type StatusResult } from './protocol.js'

/**
 * Run logs (RFC 0008 §8): `<stateDir>/runs/<runId>.ndjson`, one per
 * JSON-mode locked command (`run`, `env`, `rollback`), holding its events —
 * what `attach` replays, what `status` reports as the last run.
 *
 * The directory is 0700 and the deploy user's; a log is 0600, created
 * O_EXCL|O_NOFOLLOW and read O_NOFOLLOW with its owner and mode checked.
 * They protect it from other users, not from the app user itself (§10).
 */

export const runsDir = (stateDir: string) => join(stateDir, 'runs')
export const runLogPath = (stateDir: string, runId: string) => join(runsDir(stateDir), `${runId}.ndjson`)
/** Created by the first `cancel` of a run: a second one is the second signal. */
const cancelMarker = (stateDir: string, runId: string) => join(runsDir(stateDir), `${runId}.cancel`)

/** Retention (RFC 0008 §8.7). */
export const KEEP_RUN_LOGS = 50
export const KEEP_RUN_DAYS = 30

const RUN_FILE = /^(\d{8}T\d{6}Z-[0-9a-f]{12})\.(ndjson|cancel)$/

/** `<UTC yyyymmddThhmmssZ>-<12 hex>`. */
export function newRunId(host: Host): string {
  const stamp = host.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${host.randomHex(6)}`
}

const notOurs = (path: string, why: string) => new DeployError(`${path} is not a run log this deploy wrote (${why}) — refused`, [], 'failed')

/** Creates the runs directory (0700) or checks it: a directory, the deploy user's, nobody else's. */
export async function ensureRunsDir(host: Host, stateDir: string): Promise<string> {
  const dir = runsDir(stateDir)
  if (!(await host.stat(dir))) await host.mkdir(dir, 0o700)
  const stat = await host.stat(dir)
  if (stat?.kind !== 'dir') throw new DeployError(`${dir} is ${stat?.kind === 'symlink' ? 'a symbolic link' : 'not a directory'} — refused, never followed`, [], 'failed')
  if (stat.uid !== undefined && stat.uid !== host.uid()) throw new DeployError(`${dir} is owned by uid ${stat.uid}, not by the deploy user (uid ${host.uid()}) — refused`, [], 'failed')
  if (stat.mode !== undefined && (stat.mode & 0o077) !== 0) throw new DeployError(`${dir} is ${(stat.mode & 0o777).toString(8)}: other users could read the run logs — chmod 700 ${dir}`, [], 'failed')
  return dir
}

/** A new run log, 0600, created exclusively (a link or file already there is an error). */
export async function createRunLog(host: Host, stateDir: string, runId: string): Promise<{ path: string; handle: LogHandle }> {
  if (!host.createLog) throw new DeployError('this host cannot write run logs', [], 'unsupported')
  await ensureRunsDir(host, stateDir)
  const path = runLogPath(stateDir, runId)
  try {
    return { path, handle: await host.createLog(path, 0o600) }
  } catch (error) {
    throw new DeployError(`cannot create the run log ${path} (${(error as Error).message}): something is already there — refused, never reused or followed`, [], 'failed')
  }
}

/**
 * Keeps the newest {@link KEEP_RUN_LOGS} logs and none older than
 * {@link KEEP_RUN_DAYS} days; never `keep` (the run holding the lock). Only
 * names this package writes, by unlink(2) — never recursive.
 */
export async function pruneRunLogs(host: Host, stateDir: string, keep: string | undefined): Promise<string[]> {
  const dir = runsDir(stateDir)
  const runs = new Map<string, string[]>()
  for (const name of await host.list(dir)) {
    const match = RUN_FILE.exec(name)
    if (!match) continue
    const id = match[1] as string
    runs.set(id, [...(runs.get(id) ?? []), name])
  }
  const ids = [...runs.keys()].sort().reverse()
  const cutoff = host.now().getTime() - KEEP_RUN_DAYS * 24 * 3600 * 1000
  const removed: string[] = []
  ids.forEach((id, index) => {
    if (id === keep) return
    if (index < KEEP_RUN_LOGS && runTime(id) >= cutoff) return
    removed.push(...(runs.get(id) ?? []))
  })
  const done: string[] = []
  for (const name of removed) {
    try {
      await host.removeFile(join(dir, name))
      done.push(name)
    } catch {
      // Not a file (a directory with a log's name): left alone; retention never fails a deploy.
    }
  }
  return done
}

function runTime(runId: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runId)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : 0
}

/** One range of a run log, refused unless it is a plain file of the deploy user that nobody else can read. */
async function readRange(host: Host, path: string, offset: number, length: number): Promise<FileRange> {
  if (!host.readFileRange) throw new DeployError('this host cannot read run logs', [], 'unsupported')
  let range: FileRange
  try {
    range = await host.readFileRange(path, offset, length)
  } catch (error) {
    throw notOurs(path, (error as Error).message)
  }
  if (range.uid !== host.uid()) throw notOurs(path, `owned by uid ${range.uid}`)
  if ((range.mode & 0o077) !== 0) throw notOurs(path, `mode ${(range.mode & 0o777).toString(8)}`)
  return range
}

/** The run named by a live lock holder (`status --json`). */
export function activeRun(host: Host, lock: LockState | undefined): StatusResult['activeRun'] {
  const holder = lock?.holder
  if (!holder?.runId || lock?.stale) return undefined
  return { runId: holder.runId, pid: holder.pid, command: holder.command, actor: holder.actor, startedAt: holder.startedAt, alive: holder.host === host.hostname() && host.processAlive(holder.pid) }
}

const TAIL = 64 * 1024

/** The newest run log: its command, and how it ended — from its first and last 64 KiB. */
export async function lastRun(host: Host, stateDir: string): Promise<StatusResult['lastRun']> {
  if (!host.readFileRange) return undefined
  const newest = (await host.list(runsDir(stateDir))).filter((n) => /\.ndjson$/.test(n) && RUN_ID.test(n.slice(0, -'.ndjson'.length))).sort().at(-1)
  if (!newest) return undefined
  const runId = newest.slice(0, -'.ndjson'.length)
  const path = runLogPath(stateDir, runId)
  try {
    const head = await readRange(host, path, 0, 4096)
    const first = parseEvent(Buffer.from(head.data).toString('utf8').split('\n')[0] ?? '')
    const command = first.ok && first.value.type === 'hello' ? first.value.command : ''
    const start = Math.max(0, head.size - TAIL)
    const tail = await readRange(host, path, start, TAIL)
    const lines = Buffer.from(tail.data).toString('utf8').split('\n')
    if (start > 0) lines.shift()
    for (const line of lines.reverse()) {
      const parsed = parseEvent(line)
      if (parsed.ok && parsed.value.type === 'done') return { runId, command, exitCode: parsed.value.exitCode, complete: true, endedAt: parsed.value.ts }
    }
    return { runId, command, complete: false }
  } catch {
    return { runId, command: '', complete: false }
  }
}

// ── attach ─────────────────────────────────────────────────────────────────

export const ATTACH_POLL_MS = 250
export const VANISH_GRACE_MS = 2000
/**
 * Without `--follow`: how long a run that released its lock gets to write
 * its last events (`error`, `done`) before it is called vanished.
 */
export const LAST_EVENTS_GRACE_MS = 500
const CHUNK = 64 * 1024

export interface AttachOptions {
  fromSeq: number
  follow: boolean
  /** One run event, checked, in order. */
  emit: (event: DeployEvent) => void
}

/**
 * Replays a run log (RFC 0008 §8.4): every line checked — the envelope, a
 * known shape, `seq` exactly one more than the line before — then handed on.
 * A bad line ends the replay; raw text is never passed through. Returns the
 * run's exit code once its `done` is read, else (without `--follow`, a run
 * still alive) `undefined`.
 */
export async function attach(host: Host, stateDir: string, runId: string, options: AttachOptions): Promise<number | undefined> {
  if (!RUN_ID.test(runId)) throw new DeployError(`"${runId}" is not a run id`, [], 'usage')
  const path = runLogPath(stateDir, runId)
  if (!(await host.exists(path))) throw new DeployError(`no run ${runId} here (${path})`, [], 'not-found')
  let offset = 0
  let pending = Buffer.alloc(0)
  let expected: number | undefined
  let lineNo = 0
  let quietSince: number | undefined
  let graced = false
  for (;;) {
    const range = await readRange(host, path, offset, CHUNK)
    offset += range.data.length
    pending = Buffer.concat([pending, Buffer.from(range.data)])
    let newline: number
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      const line = pending.subarray(0, newline).toString('utf8')
      pending = pending.subarray(newline + 1)
      lineNo++
      const parsed = parseEvent(line)
      if (!parsed.ok) throw new DeployError(`run log corrupt at line ${lineNo}: ${parsed.error}`, [], 'failed')
      const event = parsed.value
      if (expected !== undefined && event.seq !== expected) throw new DeployError(`run log corrupt at line ${lineNo}: seq ${event.seq} after ${expected - 1}`, [], 'failed')
      if (expected === undefined && event.seq !== 0) throw new DeployError(`run log corrupt at line ${lineNo}: it starts at seq ${event.seq}`, [], 'failed')
      expected = event.seq + 1
      if (event.seq >= options.fromSeq) options.emit(event)
      if (event.type === 'done') return event.exitCode
    }
    if (pending.length > 2 * CHUNK) throw new DeployError(`run log corrupt at line ${lineNo + 1}: a line longer than ${2 * CHUNK} bytes`, [], 'failed')
    if (range.data.length > 0) { quietSince = undefined; continue }
    // At the end of what is written: the run may still be writing.
    const alive = await runAlive(host, stateDir, runId)
    if (!options.follow) {
      if (alive) return undefined
      // The lock is released before `done` is written: one more look before calling the run gone.
      if (!graced) {
        graced = true
        await host.sleep(LAST_EVENTS_GRACE_MS)
        continue
      }
      throw new DeployError(`run ${runId} ended without its last event (stopped at once by a second signal, killed, or out of memory)`, [], 'run-vanished')
    }
    if (alive) quietSince = undefined
    else {
      quietSince ??= host.now().getTime()
      if (host.now().getTime() - quietSince >= VANISH_GRACE_MS) {
        throw new DeployError(`run ${runId} is gone without its last event (stopped at once by a second signal, killed, or out of memory)`, [], 'run-vanished')
      }
    }
    await host.sleep(ATTACH_POLL_MS)
  }
}

/** The lock names this run, held by a live process on this host. */
async function runAlive(host: Host, stateDir: string, runId: string): Promise<boolean> {
  const lock = await readLock(host, stateDir)
  const holder = lock?.holder
  return Boolean(holder && holder.runId === runId && holder.host === host.hostname() && host.processAlive(holder.pid))
}

// ── cancel ─────────────────────────────────────────────────────────────────

/**
 * SIGTERM to the deploy holding the lock for `runId` (RFC 0008 §8.5) — only
 * when its runId, host, a live pid and its own argv (`--run-id=<id>`, from
 * /proc) all say it is that run: a recycled pid is never signalled. Where the
 * argv cannot be read (not Linux), refused. A second cancel is the second
 * signal: the run stops at once.
 */
export async function cancel(host: Host, stateDir: string, runId: string): Promise<{ pid: number; second: boolean }> {
  if (!RUN_ID.test(runId)) throw new DeployError(`"${runId}" is not a run id`, [], 'usage')
  if (!host.kill || !host.processCmdline) throw new DeployError('cancel needs a host that can signal a process and read its argv', [], 'unsupported')
  const holder = (await readLock(host, stateDir))?.holder
  if (!holder || holder.runId !== runId || holder.host !== host.hostname() || !host.processAlive(holder.pid)) {
    throw new DeployError(`no running deploy holds the lock for run ${runId}`, [], 'not-found')
  }
  const argv = await host.processCmdline(holder.pid)
  if (argv === undefined) throw new DeployError(`cannot read the argv of pid ${holder.pid} (no /proc): its identity cannot be checked, so it is not signalled`, [], 'unsupported')
  // A detached run carries its id in its argv; an attended one does not, and stops with its SSH session.
  if (!argv.includes(`--run-id=${runId}`)) {
    throw new DeployError(`pid ${holder.pid} does not carry --run-id=${runId} in its command line: not signalled`, [], 'not-found', 'only a detached run (run --detach) can be cancelled; an attended run stops when its SSH session ends')
  }
  await ensureRunsDir(host, stateDir)
  const first = await host.createExclusive(cancelMarker(stateDir, runId), `${host.now().toISOString()}\n`, 0o600)
  host.kill(holder.pid, 'SIGTERM')
  return { pid: holder.pid, second: !first }
}

/** The complete, valid events a run log holds now (up to 1 MiB): what the detaching parent waits on. */
export async function scanRunLog(host: Host, path: string): Promise<DeployEvent[]> {
  const range = await readRange(host, path, 0, 1024 * 1024)
  const text = Buffer.from(range.data).toString('utf8')
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  const events: DeployEvent[] = []
  for (const line of complete.split('\n')) {
    if (!line) continue
    const parsed = parseEvent(line)
    if (!parsed.ok) throw new DeployError(`run log corrupt: ${parsed.error}`, [], 'failed')
    events.push(parsed.value)
  }
  return events
}
