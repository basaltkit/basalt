import { dirname, normalize } from 'node:path'
import { DeployError } from './context.js'
import type { Host } from './host.js'

/**
 * The trust boundary between the app user and root (RFC 0006 §11.4).
 *
 * The app user can change its checkout: `deploy.config.ts`, `node_modules`,
 * every file in the tree. Root therefore never runs any of it. `install`
 * reads a data-only plan the app user wrote (`install-plan`), validates every
 * field again with the patterns below, and writes only where the app user
 * cannot plant a link: root-owned directories, or files opened with
 * O_NOFOLLOW and changed through their descriptor.
 */

/** A login name: what `useradd` accepts, never an option or a path. */
export const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/

/** A path segment with no leading dot: never `.`, `..`, `.git`, `.env`, `.basalt`. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** Directory served by the proxy, relative to the checkout: inside it, never the checkout itself, never a dot directory. */
export function isWebRoot(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false
  return value.replace(/\/$/, '').split('/').every((segment) => SEGMENT.test(segment))
}

/** `/api`, `/api/v1/`: URL path segments, no dot segments, nothing a config file would parse. */
export const API_PREFIX = /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+\/?$/

/** An on-demand TLS `ask` path on the app. */
export const ASK_PATH = /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/

/** A Let's Encrypt certificate name (`/etc/letsencrypt/live/<name>/`). */
export const CERT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)*$/

/** An absolute directory with no dot segments (`/etc/apache2`). */
export function isConfigRoot(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 200) return false
  return value.slice(1).split('/').every((segment) => SEGMENT.test(segment))
}

/** An env file name in `/etc/<app>/`. */
const ENV_NAME = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/

/**
 * Where an env file may live: inside the checkout (relative, no `..`), or
 * directly in `/etc/<app>/`. Never `/etc/environment`, never another app's
 * directory — `install` hands these files to the app user.
 */
export function envLocationProblem(app: string, file: string): string | undefined {
  if (file.startsWith('/')) {
    const name = file.slice(`/etc/${app}/`.length)
    if (file.startsWith(`/etc/${app}/`) && ENV_NAME.test(name) && name !== '.' && name !== '..' && normalize(file) === file) return undefined
    return `"${file}" must be inside the checkout or directly in /etc/${app}/ (install gives it to the deploy user)`
  }
  if (file.length === 0 || file.includes('\0') || file.split('/').some((segment) => segment === '..' || segment === '')) {
    return `"${file}" must stay inside the checkout (no "..")`
  }
  return undefined
}

/** Owned by root, and nobody else can write it (a world-writable sticky directory is fine: nobody can replace root's entries). */
function rootOnly(stat: { uid?: number; gid?: number; mode?: number; kind: string }): boolean {
  if (stat.uid !== 0 || stat.mode === undefined) return false
  if ((stat.mode & 0o020) !== 0 && stat.gid !== 0) return false
  if ((stat.mode & 0o002) !== 0 && !(stat.kind === 'dir' && (stat.mode & 0o1000) !== 0)) return false
  return true
}

/**
 * Every directory from `path` up to `/` is root's and writable by root only —
 * so no other user can swap an entry under root while it writes there.
 * Returns the first one that is not, or `undefined`.
 */
export async function untrustedAncestor(host: Host, path: string): Promise<string | undefined> {
  for (let dir = path; ; dir = dirname(dir)) {
    const stat = await host.stat(dir)
    if (!stat || stat.kind !== 'dir' || !rootOnly(stat)) return dir
    if (dir === '/') return undefined
  }
}

/** Throws unless root alone controls `dir` and every directory above it. */
export async function assertRootOwnedDir(host: Host, dir: string, what: string): Promise<void> {
  const bad = await untrustedAncestor(host, dir)
  if (bad) throw new DeployError(`${what}: ${bad} is not a directory only root can write — root does not write under a path another user can change`)
}

/**
 * The tool root is about to run: the node binary and this package's own
 * files, each root's (after symlinks) in directories only root can write.
 * `sudo node node_modules/@basaltkit/deploy/dist/bin.js` from the checkout
 * fails this — that file is the app user's to change.
 */
export async function untrustedToolPaths(host: Host, paths: string[]): Promise<string[]> {
  const problems: string[] = []
  for (const path of paths) {
    const real = await host.realpath(path)
    if (!real) { problems.push(`${path} (not found)`); continue }
    const stat = await host.stat(real)
    if (!stat || !rootOnly(stat)) { problems.push(`${real} (owned by uid ${stat?.uid ?? '?'}, or writable by others)`); continue }
    const bad = await untrustedAncestor(host, dirname(real))
    if (bad) problems.push(`${real} (its directory ${bad} is not root's alone)`)
  }
  return problems
}
