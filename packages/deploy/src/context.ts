import { join } from 'node:path'
import type { Audit } from './audit.js'
import type { DeployConfig } from './config.js'
import type { Host } from './host.js'

export interface DeployContext {
  config: DeployConfig
  /** The app's checkout. */
  dir: string
  host: Host
  /** The package manager the project declares (`packageManager`, else its lockfile). */
  pm: 'pnpm' | 'npm' | 'yarn' | 'bun'
  envPath: string
  /** Releases, generated infra files. `/var/lib/basalt/<app>` once `install` ran, else `<dir>/.basalt`. */
  stateDir: string
  /**
   * The `.env` as last read or written — what `compose({ passEnv })` hands to
   * compose in its environment (never on a command line, never in a file).
   */
  values?: Map<string, string>
  /** Container addresses → their 127.0.0.1 form, for what runs on the host (`dockerInfra({ access: 'containers' })`). */
  hostUrls?: Array<[string, string]>
  /** Set while a locked command runs; a signal marks it, the next step boundary acts on it. */
  abort?: AbortState
  /** Who runs the command, from where — stamped on every release it records. */
  audit?: Audit
}

export interface AbortState {
  /** The first SIGINT/SIGTERM/SIGHUP heard. */
  signal?: string
  /** Past the point where stopping is safe (release, rollback, install): finish, then exit. */
  deferred: boolean
}

export interface Finding {
  /** The RFC 0006 §5 check id (`C1`…`C10`) or a step name. */
  id: string
  level: 'error' | 'warning'
  message: string
  /** One line the operator can act on. */
  fix?: string
}

/** The tool, run by `node` on its file — never `pnpm exec` (see {@link RUN_COMMAND}). */
const BIN = 'node_modules/@basaltkit/deploy/dist/bin.js'

/**
 * How the app user runs the deploy. Not `pnpm exec`: pnpm ≥ 12 rewrites
 * `pnpm-lock.yaml` on any command in the checkout when the lockfile came from
 * another pnpm, and the deploy then refuses its own dirty tree.
 */
export const RUN_COMMAND = `node ${BIN} run`

/**
 * How an administrator runs `install`. The node binary is resolved by the
 * operator's shell BEFORE sudo: with a per-user Node (nvm, fnm, volta) root
 * has no `node` on its PATH — `sudo node` failed with "command not found" on
 * the first server. Not `pnpm exec` either: root often has no pnpm.
 */
export const INSTALL_COMMAND = `sudo "$(command -v node)" ${BIN} install --user="$USER"`

export const errors = (findings: Finding[]) => findings.filter((f) => f.level === 'error')

export function report(host: Host, findings: Finding[]): void {
  for (const finding of findings) {
    const line = `[${finding.id}] ${finding.message}${finding.fix ? `\n      → ${finding.fix}` : ''}`
    if (finding.level === 'error') host.out.error(line)
    else host.out.warn(line)
  }
}

export async function detectPackageManager(host: Host, dir: string): Promise<DeployContext['pm']> {
  const text = await host.readFile(join(dir, 'package.json'))
  if (text) {
    try {
      const declared = String((JSON.parse(text) as { packageManager?: unknown }).packageManager ?? '')
      const name = declared.split('@')[0]
      if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name
    } catch {
      // An unreadable package.json is the build step's error to report.
    }
  }
  if (await host.exists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await host.exists(join(dir, 'yarn.lock'))) return 'yarn'
  if (await host.exists(join(dir, 'bun.lock'))) return 'bun'
  return 'npm'
}

export async function resolveStateDir(host: Host, config: DeployConfig, dir: string): Promise<string> {
  const system = `/var/lib/basalt/${config.app}`
  return (await host.stat(system))?.kind === 'dir' ? system : join(dir, '.basalt')
}

export class DeployError extends Error {
  constructor(message: string, readonly findings: Finding[] = []) {
    super(message)
    this.name = 'DeployError'
  }
}

/** A signal stopped the command at a step boundary (after putting the code back). */
export class DeployAbortedError extends DeployError {
  constructor(readonly signal: string, detail?: string) {
    super(`stopped by ${signal}${detail ? ` — ${detail}` : ''}`)
    this.name = 'DeployAbortedError'
  }
}

/** Throws {@link DeployAbortedError} when a signal arrived and stopping is still safe. */
export function throwIfAborted(ctx: DeployContext): void {
  const abort = ctx.abort
  if (abort?.signal && !abort.deferred) throw new DeployAbortedError(abort.signal)
}
