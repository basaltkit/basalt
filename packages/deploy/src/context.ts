import { join } from 'node:path'
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
}

export interface Finding {
  /** The RFC 0006 §5 check id (`C1`…`C10`) or a step name. */
  id: string
  level: 'error' | 'warning'
  message: string
  /** One line the operator can act on. */
  fix?: string
}

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
