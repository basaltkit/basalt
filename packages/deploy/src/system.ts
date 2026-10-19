import type { Finding } from './context.js'
import type { Host } from './host.js'

/**
 * `system.packages` — the OS binaries the app runs (OCR, PDF tools, `unzip`):
 * Debian/Ubuntu apt package names, declared in deploy.config.ts so that a
 * server without them fails the preflight, not the first user who reaches the
 * feature.
 *
 * Two sides, as everywhere else (RFC 0006 §11.4): the app user only checks
 * (`dpkg-query`, C12) and prints the fix; root installs — `bootstrap` and
 * `install` — from the install plan's list, a field it validates again. The
 * names reach apt as arguments, never through a shell.
 */

/**
 * An apt package name (Debian Policy §5.6.1, lowercase only): never an option
 * (`-…`), never a path, a version (`=`), a release (`/`), a glob or shell syntax.
 */
export const SYSTEM_PACKAGE = /^[a-z0-9][a-z0-9.+-]{1,62}$/
/** More than any app needs; a cap on what root is asked to install. */
export const MAX_SYSTEM_PACKAGES = 64

/** apt as root: no question can block it (there may be no terminal). */
export const APT = ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get']

/** Every problem with a package list, as `where` names it (`system.packages`); none → []. */
export function systemPackageProblems(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) return [`${where} must be a list of apt package names`]
  const problems: string[] = []
  if (value.length > MAX_SYSTEM_PACKAGES) problems.push(`${where}: at most ${MAX_SYSTEM_PACKAGES} packages`)
  for (const name of value) {
    if (typeof name !== 'string' || !SYSTEM_PACKAGE.test(name)) problems.push(`${where}: "${String(name)}" is not an apt package name (${SYSTEM_PACKAGE})`)
  }
  if (new Set(value).size !== value.length) problems.push(`${where}: each package once`)
  return problems
}

export interface PackageStatus {
  /** Declared and not installed. */
  missing: string[]
  /** No `dpkg-query` here (not Debian/Ubuntu): nothing could be checked. */
  unverified: boolean
}

/**
 * dpkg's "<want> <error> <status>", matched by its closed vocabularies: with
 * no separator in the format, two architectures' statuses run together
 * (`hold ok installedinstall ok installed`), and `\S+` would read one word.
 */
const STATUS = /(unknown|install|hold|deinstall|purge) (ok|reinstreq) (not-installed|config-files|half-installed|unpacked|half-configured|triggers-awaited|triggers-pending|installed)/g

/**
 * Which declared packages are not installed: `dpkg-query -W -f=${Status} <pkg>`,
 * one argv per package. The status is "<want> <flag> <status>"; installed is
 * the third word (`install ok installed`, or `hold ok installed`). An unknown
 * package exits non-zero: missing. A package of several architectures prints
 * one status each, run together: installed when one of them is.
 */
export async function packageStatus(host: Host, packages: readonly string[], cwd: string): Promise<PackageStatus> {
  const missing: string[] = []
  for (const name of packages) {
    const result = await host.exec('dpkg-query', ['-W', '-f=${Status}', name], { cwd })
    // 127: the command itself is absent (spawn failed) — not a Debian system.
    if (result.code === 127) return { missing: [], unverified: true }
    const statuses = [...result.stdout.matchAll(STATUS)].map((m) => m[3])
    if (result.code !== 0 || statuses.length === 0 || !statuses.includes('installed')) missing.push(name)
  }
  return { missing, unverified: false }
}

/** The command an administrator runs for the missing packages — printed, never run by the app user. */
export const fixCommand = (missing: readonly string[]) => `sudo apt-get install -y ${missing.join(' ')}`

/**
 * C12 — the declared OS packages are installed. Missing is an error: the
 * release would build and start, then fail on the first request that needs
 * one. No `dpkg-query` is a warning: the deploy cannot tell, and cannot fix it.
 */
export function systemFindings(packages: readonly string[], status: PackageStatus): Finding[] {
  if (packages.length === 0) return []
  if (status.unverified) {
    return [{ id: 'C12', level: 'warning', message: `system.packages (${packages.join(', ')}) cannot be verified: no dpkg-query on this server (Debian/Ubuntu only)` }]
  }
  if (status.missing.length === 0) return []
  return [{
    id: 'C12',
    level: 'error',
    message: `system package${status.missing.length > 1 ? 's' : ''} not installed: ${status.missing.join(', ')}`,
    fix: fixCommand(status.missing),
  }]
}

/** What `plan` prints for the packages. */
export function describeSystem(packages: readonly string[], status: PackageStatus | undefined): string[] {
  if (packages.length === 0) return []
  const state = !status || status.unverified ? 'not verified: no dpkg-query' : status.missing.length ? `missing: ${status.missing.join(', ')}` : 'installed'
  return [`${packages.join(', ')} (${state})`]
}

/** Root's commands: the index refreshed once, then the packages — argv, no shell, no recommends. */
export const aptInstall = (packages: readonly string[]): string[][] => [
  [...APT, 'update', '-qq'],
  [...APT, 'install', '-y', '-qq', '--no-install-recommends', ...packages],
]
