import { DeployError, type DeployContext } from './context.js'
import type { Host } from './host.js'
import type { Release } from './state.js'

/**
 * Who deployed, from where, how — kept with every release record (and, with
 * `audit: { syslog: true }`, sent to the system log). Facts the process can
 * see, never secrets: `$SSH_CONNECTION`'s client address, not a key.
 */
export interface Audit {
  /** `--actor`, else `$BASALT_DEPLOY_ACTOR`, else `$USER` (a shared account names a person this way). */
  actor: string
  /** The SSH client address, when the deploy runs over SSH. */
  client?: string
  /** `ssh`, `ci`, `terminal`, `batch` (cron, a pipe) or `ui` (`--via=ui`: a program drove the CLI over SSH). */
  via: string
}

const ACTOR = /^[A-Za-z0-9._@+-]{1,64}$/

/** `via` is self-declared, like `--actor`: it attributes, it does not authenticate (RFC 0008 §8.6). */
export function auditOf(host: Host, declared?: string, declaredVia?: 'ui'): Audit {
  const named = declared ?? host.env['BASALT_DEPLOY_ACTOR']
  if (named !== undefined && !ACTOR.test(named)) throw new DeployError(`--actor "${named}": 1–64 of letters, digits and . _ @ + -`)
  const actor = named ?? host.env['USER'] ?? String(host.uid())
  // "client-ip client-port server-ip server-port": split, never a regex over the whole input.
  const ip = (host.env['SSH_CONNECTION'] ?? '').trim().split(/\s+/)[0] ?? ''
  const client = /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : undefined
  const via = declaredVia ?? (client ? 'ssh' : host.env['CI'] ? 'ci' : host.interactive() ? 'terminal' : 'batch')
  return { actor, ...(client ? { client } : {}), via }
}

/** One line per recorded release in the system log (`logger -t basalt-deploy`), best effort. */
export async function syslogRelease(ctx: DeployContext, release: Release): Promise<void> {
  if (!ctx.config.audit?.syslog) return
  const fields = [
    `app=${ctx.config.app}`, `sha=${release.sha.slice(0, 12)}`, `status=${release.status}`,
    `actor=${release.actor ?? release.user}`, ...(release.client ? [`client=${release.client}`] : []), ...(release.via ? [`via=${release.via}`] : []),
  ]
  const result = await ctx.host.exec('logger', ['-t', 'basalt-deploy', '--', fields.join(' ')])
  if (result.code !== 0) ctx.host.out.warn(`audit.syslog: logger failed (${result.stderr.trim() || `exit ${result.code}`}) — the release is recorded in releases.json`)
}
