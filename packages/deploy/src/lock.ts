import { join } from 'node:path'
import { DeployError } from './context.js'
import type { Host } from './host.js'
import { RUN_ID } from './protocol.js'

/**
 * One deploy at a time per app: `<stateDir>/deploy.lock`, created with
 * O_EXCL (never followed through a symlink), holding who took it. Two runs —
 * a cron and a person, say — would otherwise interleave fetch, build,
 * migrate and restart, and each rewrite `releases.json` from its own read.
 *
 * A lock whose process is gone (same host, dead pid) is stale and taken
 * over; anything else is refused, fail-closed, with the way to clear it.
 */

export interface LockHolder {
  pid: number
  host: string
  startedAt: string
  actor: string
  command: string
  /** The run this deploy writes its events to (`--json`, RFC 0008 §8.3): what `attach` and `cancel` name. */
  runId?: string
}

export const lockFile = (stateDir: string) => join(stateDir, 'deploy.lock')
/** Held for the few milliseconds a stale lock is replaced: only one process judges and removes it. */
export const takeoverFile = (stateDir: string) => join(stateDir, 'deploy.lock.takeover')
const MAX_LOCK_BYTES = 4096

/**
 * The lock file's text, read without following a link and at most 4 KiB —
 * the state directory is the app user's, and root takes this lock too
 * (`install`): a link to /dev/zero or a FIFO there must not hang root.
 * `undefined` when it is not there; '' when it is not a plain small file.
 */
async function readLockText(host: Host, path: string): Promise<string | undefined> {
  if (!(await host.exists(path))) return undefined
  try {
    return await host.readPlainFile(path, MAX_LOCK_BYTES)
  } catch {
    return (await host.exists(path)) ? '' : undefined
  }
}

const sameHolder = (a: LockHolder | undefined, b: LockHolder) => a !== undefined && a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt

export class DeployLockedError extends DeployError {
  constructor(message: string, readonly holder?: LockHolder) {
    super(message)
    this.name = 'DeployLockedError'
  }
}

export interface LockState {
  path: string
  holder?: LockHolder
  /** The holder's process is gone (same host): the next deploy takes it over. */
  stale: boolean
  /** Not a lock this package wrote (empty, or not JSON): refused until removed by hand. */
  corrupt: boolean
}

function parseHolder(text: string | undefined): LockHolder | undefined {
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Partial<LockHolder>
    if (typeof value.pid !== 'number' || typeof value.host !== 'string') return undefined
    return {
      pid: value.pid,
      host: value.host,
      startedAt: String(value.startedAt ?? ''),
      actor: String(value.actor ?? ''),
      command: String(value.command ?? ''),
      ...(typeof value.runId === 'string' && RUN_ID.test(value.runId) ? { runId: value.runId } : {}),
    }
  } catch {
    return undefined
  }
}

/** The lock as it is now, or `undefined` when no deploy holds it. */
export async function readLock(host: Host, stateDir: string): Promise<LockState | undefined> {
  const path = lockFile(stateDir)
  const text = await readLockText(host, path)
  if (text === undefined) return undefined
  const holder = parseHolder(text)
  if (!holder) return { path, stale: false, corrupt: true }
  const stale = holder.host === host.hostname() && !host.processAlive(holder.pid)
  return { path, holder, stale, corrupt: false }
}

export const describeHolder = (h: LockHolder) =>
  `${h.command || 'a deploy'} by ${h.actor || 'someone'} (pid ${h.pid} on ${h.host}, since ${h.startedAt || 'an unknown time'})`

/**
 * Takes the lock or throws {@link DeployLockedError}. Returns the release,
 * which removes the file only while it is still this process's lock.
 *
 * Every removal is unlink(2), never recursive: the directory may be the app
 * user's while root holds the lock, and a lock swapped for a directory or a
 * link must not lead root into removing anything else.
 */
export async function acquireLock(host: Host, stateDir: string, command: string, actor: string, runId?: string): Promise<() => Promise<void>> {
  await host.mkdir(stateDir, 0o700)
  const path = lockFile(stateDir)
  const mine: LockHolder = { pid: host.pid(), host: host.hostname(), startedAt: host.now().toISOString(), actor, command, ...(runId ? { runId } : {}) }
  const text = `${JSON.stringify(mine)}\n`
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await host.createExclusive(path, text, 0o600)) {
      return async () => {
        if (sameHolder(parseHolder(await readLockText(host, path)), mine)) await host.removeFile(path)
      }
    }
    const state = await readLock(host, stateDir)
    if (!state) continue
    if (state.corrupt) {
      throw new DeployLockedError(`${path} exists but is not a deploy lock (empty, unreadable or not a plain file) — if no deploy is running: rm ${path}`)
    }
    const holder = state.holder as LockHolder
    if (state.stale && attempt === 0) {
      await takeOver(host, stateDir, holder, mine)
      continue
    }
    throw new DeployLockedError(
      `another deploy is running: ${describeHolder(holder)} — wait for it${holder.host === host.hostname() ? '' : `, or, if nothing runs on ${holder.host}: rm ${path}`}`,
      holder,
    )
  }
  throw new DeployLockedError(`could not take ${path}`)
}

/**
 * Removes a stale lock — only the one judged stale. Two deploys that both
 * read the same dead holder would otherwise each remove "it": the second
 * removal would hit the first one's fresh lock, and both would run. The
 * takeover file (O_EXCL) lets one process at a time re-read and remove; the
 * other is told a deploy is starting.
 */
async function takeOver(host: Host, stateDir: string, stale: LockHolder, mine: LockHolder): Promise<void> {
  const path = lockFile(stateDir)
  const guard = takeoverFile(stateDir)
  if (!(await host.createExclusive(guard, `${JSON.stringify(mine)}\n`, 0o600))) {
    throw new DeployLockedError(`another deploy is taking over the stale lock in ${stateDir} — if none runs (a takeover lasts milliseconds): rm ${guard}`)
  }
  try {
    if (sameHolder(parseHolder(await readLockText(host, path)), stale)) {
      host.out.warn(`removed a stale lock: ${describeHolder(stale)} — that process is gone`)
      await host.removeFile(path)
    }
  } finally {
    await host.removeFile(guard)
  }
}
