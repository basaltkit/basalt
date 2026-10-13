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

/**
 * Characters a terminal acts on instead of showing (CR, ESC and the C1 CSI,
 * line separators, bidirectional overrides): `install` shows raw Caddy
 * `extra` before root writes it, and what is shown must be what is written.
 */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/

/**
 * Raw Caddy `extra`: no character that hides text on a terminal, and no
 * `import` — a file the app user can change later would be configuration
 * root loads without anyone seeing it again.
 */
export function caddyExtraProblem(extra: unknown): string | undefined {
  if (typeof extra !== 'string' || extra.length > 16_384) return 'must be a string (at most 16 KiB)'
  const hidden = HIDDEN.exec(extra)
  if (hidden) return `holds a control or direction character (U+${(hidden[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}) — tabs and newlines only`
  if (/^\s*import(\s|$)/m.test(extra)) return 'may not `import` a file: root would load whatever that file says later, unseen'
  return undefined
}

/**
 * The managed vhost file name: the app's own (`<app>.conf`, `<app>-<x>.conf`),
 * never one that sorts ahead of another site's or takes its name.
 */
export function vhostFileProblem(app: string, vhost: unknown): string | undefined {
  if (typeof vhost !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.conf$/.test(vhost)) return 'must be a plain *.conf file name'
  if (vhost !== `${app}.conf` && !vhost.startsWith(`${app}-`) && !vhost.startsWith(`${app}.`)) return `must be ${app}.conf or start with "${app}-" — the app's own file`
  return undefined
}

/** An absolute directory with no dot segments (`/etc/apache2`). */
export function isConfigRoot(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 200) return false
  return value.slice(1).split('/').every((segment) => SEGMENT.test(segment))
}

/**
 * App names whose `/etc/<app>` is a system directory (or this tool's own
 * `/etc/basalt`). `install` hands `/etc/<app>` to the app user when the env
 * lives there: owning `/etc/systemd`, `/etc/ssh` or `/etc/apt` is root. The
 * list is a first line; `install` also refuses a directory a Debian package
 * ships, one another user owns, and asks before taking over one root made.
 */
export const RESERVED_APP_NAMES: ReadonlySet<string> = new Set([
  'basalt', 'basaltkit', 'alternatives', 'apache2', 'apparmor', 'apt', 'bash-completion', 'bind', 'ca-certificates', 'caddy', 'cloud', 'containerd',
  'cron', 'cryptsetup-initramfs', 'dbus-1', 'default', 'dhcp', 'docker', 'dpkg', 'fail2ban', 'fonts', 'gnupg', 'groff', 'grub', 'gss', 'init', 'initramfs-tools',
  'iproute2', 'iptables', 'kernel', 'ldap', 'letsencrypt', 'libvirt', 'logcheck', 'logrotate', 'lvm', 'mysql', 'netplan', 'network', 'networkd-dispatcher', 'nftables', 'nginx',
  'node', 'nodejs', 'npm', 'openvpn', 'opt', 'pam', 'php', 'pki', 'pm2', 'polkit-1', 'postfix', 'postgresql', 'postgresql-common', 'ppp', 'profile', 'python3', 'redis',
  'resolvconf', 'rsyslog', 'security', 'selinux', 'skel', 'snap', 'ssh', 'ssl', 'sudo', 'sysctl', 'systemd', 'terminfo', 'tmpfiles', 'udev', 'ufw', 'update-motd',
  'vim', 'wireguard', 'xdg',
])

/** An env file name in `/etc/<app>/`. */
const ENV_NAME = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/

/**
 * Where an env file may live: inside the checkout (relative, no `..`), or
 * directly in `/etc/<app>/`. Never `/etc/environment`, never another app's
 * directory — `install` hands these files to the app user.
 */
export function envLocationProblem(app: string, file: string): string | undefined {
  if (file.startsWith('/')) {
    if (RESERVED_APP_NAMES.has(app)) return `"${file}": /etc/${app} is a system directory — keep the env inside the checkout, or name the app something else`
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
