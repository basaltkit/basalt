import { join } from 'node:path'
import { DeployError } from './context.js'
import type { Host } from './host.js'

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
}

export const lockFile = (stateDir: string) => join(stateDir, 'deploy.lock')

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
    }
  } catch {
    return undefined
  }
}

/** The lock as it is now, or `undefined` when no deploy holds it. */
export async function readLock(host: Host, stateDir: string): Promise<LockState | undefined> {
  const path = lockFile(stateDir)
  if (!(await host.exists(path))) return undefined
  const holder = parseHolder(await host.readFile(path))
  if (!holder) return { path, stale: false, corrupt: true }
  const stale = holder.host === host.hostname() && !host.processAlive(holder.pid)
  return { path, holder, stale, corrupt: false }
}

export const describeHolder = (h: LockHolder) =>
  `${h.command || 'a deploy'} by ${h.actor || 'someone'} (pid ${h.pid} on ${h.host}, since ${h.startedAt || 'an unknown time'})`

/**
 * Takes the lock or throws {@link DeployLockedError}. Returns the release,
 * which removes the file only while it is still this process's lock.
 */
export async function acquireLock(host: Host, stateDir: string, command: string, actor: string): Promise<() => Promise<void>> {
  await host.mkdir(stateDir, 0o700)
  const path = lockFile(stateDir)
  const mine: LockHolder = { pid: host.pid(), host: host.hostname(), startedAt: host.now().toISOString(), actor, command }
  const text = `${JSON.stringify(mine)}\n`
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await host.createExclusive(path, text, 0o600)) {
      return async () => {
        const now = parseHolder(await host.readFile(path))
        if (now && now.pid === mine.pid && now.host === mine.host && now.startedAt === mine.startedAt) await host.remove(path)
      }
    }
    const state = await readLock(host, stateDir)
    if (!state) continue
    if (state.corrupt) {
      throw new DeployLockedError(`${path} exists but is not a deploy lock (empty or unreadable) — if no deploy is running: rm ${path}`)
    }
    const holder = state.holder as LockHolder
    if (state.stale && attempt === 0) {
      host.out.warn(`removed a stale lock: ${describeHolder(holder)} — that process is gone`)
      await host.remove(path)
      continue
    }
    throw new DeployLockedError(
      `another deploy is running: ${describeHolder(holder)} — wait for it${holder.host === host.hostname() ? '' : `, or, if nothing runs on ${holder.host}: rm ${path}`}`,
      holder,
    )
  }
  throw new DeployLockedError(`could not take ${path}`)
}
