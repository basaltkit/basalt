import { basename, dirname, join, normalize } from 'node:path'
import { apacheInstall, vhostPaths } from './apache.js'
import { caddyInstall, caddyPaths } from './caddy.js'
import { APP_NAME, DOMAIN, vhostName, type ApacheProxy, type CaddyProxy, type DeployConfig } from './config.js'
import { DeployError, RUN_COMMAND, type DeployContext } from './context.js'
import { envValues } from './dotenv.js'
import { envFile, envMirrors, readEnv } from './env-step.js'
import type { Host } from './host.js'
import { acquireLock } from './lock.js'
import { covers } from './checks.js'
import { API_PREFIX, ASK_PATH, assertRootOwnedDir, caddyExtraProblem, CERT_NAME, envLocationProblem, isConfigRoot, isWebRoot, USER_NAME, vhostFileProblem } from './trust.js'

/**
 * `install` in two halves (RFC 0006 §11.4), so that root never runs code the
 * app user can change:
 *
 *   1. as the app user — `install-plan`: loads deploy.config.ts and writes
 *      what install needs as plain JSON (no function, no path it can choose
 *      freely);
 *   2. as root, with a copy of this tool root owns — `install --plan=<file>`:
 *      reads that JSON without following a link, validates every field again,
 *      and only then writes: the state directory, the proxy site, the env
 *      files' ownership.
 *
 * The plan is untrusted input to root. Everything root writes comes from a
 * field matched against a fixed pattern here; anything that would land raw in
 * a config file (Caddy `extra`, a non-default config root) is shown and needs
 * a "yes" at the terminal.
 */

export const PLAN_KIND = 'basalt-deploy/install-plan'
const MAX_PLAN_BYTES = 64 * 1024

export type PlanProxy =
  | { kind: 'none' }
  | { kind: 'apache'; managed: boolean; vhost: string; webRoot: string; apiPrefix: string; certName?: string; root?: string }
  | { kind: 'caddy'; managed: boolean; webRoot: string; apiPrefix: string; onDemandTls?: { ask: string }; extra?: string; root?: string }

export interface InstallPlan {
  kind: typeof PLAN_KIND
  version: 1
  app: string
  domain: string
  tenants: 'subdomain' | 'none'
  /** The checkout, absolute. install checks it is the app user's own directory. */
  dir: string
  /** The upstream port the proxy site points at. */
  port: number
  proxy: PlanProxy
  /** The `.env` and mirrors OUTSIDE the checkout — always directly in `/etc/<app>/`. */
  envFiles: string[]
  /** The app uses Docker (dedicated infra or the compose runtime). */
  docker: boolean
  /** `bootstrap` settings, for `bootstrap` only. */
  bootstrap?: { swapGb?: number; firewall?: boolean }
  /** The @basaltkit/deploy version that wrote the plan (informational). */
  tool: string
}

// ── the app user's half ────────────────────────────────────────────────────

/** What install needs, from the loaded config. Fails, as the app user, on anything install would refuse. */
export async function buildInstallPlan(ctx: DeployContext, tool: string): Promise<InstallPlan> {
  const { config } = ctx
  const port = config.runtime.kind === 'compose' ? config.runtime.upstream.port : Number(envValues(await readEnv(ctx)).get('PORT'))
  if (!Number.isInteger(port) || port <= 0) throw new DeployError(`no PORT in the .env yet: run \`${RUN_COMMAND.replace(/ run$/, ' env')}\` first`)
  const plan: InstallPlan = {
    kind: PLAN_KIND,
    version: 1,
    app: config.app,
    domain: config.domain,
    tenants: config.tenants ?? 'none',
    dir: ctx.dir,
    port,
    proxy: planProxy(config),
    envFiles: [envFile(ctx), ...envMirrors(ctx)].filter((f) => !f.startsWith(`${ctx.dir}/`)),
    docker: config.infra?.kind === 'docker' || config.runtime.kind === 'compose',
    ...(config.bootstrap ? { bootstrap: { ...config.bootstrap } } : {}),
    tool,
  }
  // Root will run exactly these checks: refuse now, where the fix is.
  parseInstallPlan(JSON.stringify(plan), 'the plan')
  return plan
}

function planProxy(config: DeployConfig): PlanProxy {
  const proxy = config.proxy
  if (proxy?.kind === 'apache') {
    return {
      kind: 'apache', managed: proxy.managed !== false, vhost: vhostName(config) as string, webRoot: proxy.webRoot, apiPrefix: proxy.apiPrefix,
      ...(proxy.certName === undefined ? {} : { certName: proxy.certName }),
      ...(proxy.root === undefined ? {} : { root: proxy.root }),
    }
  }
  if (proxy?.kind === 'caddy') {
    return {
      kind: 'caddy', managed: proxy.managed !== false, webRoot: proxy.webRoot, apiPrefix: proxy.apiPrefix,
      ...(proxy.onDemandTls ? { onDemandTls: { ask: proxy.onDemandTls.ask } } : {}),
      ...(proxy.extra === undefined ? {} : { extra: proxy.extra }),
      ...(proxy.root === undefined ? {} : { root: proxy.root }),
    }
  }
  return { kind: 'none' }
}

// ── validation: the same on both sides ─────────────────────────────────────

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Parses and validates a plan; every problem is listed. The text is data, never evaluated. */
export function parseInstallPlan(text: string, source: string): InstallPlan {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new DeployError(`${source} is not JSON — write it with install-plan`)
  }
  const problems: string[] = []
  const plan = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>
  const known = (record: Record<string, unknown>, keys: string[], where: string) => {
    for (const key of Object.keys(record)) if (!keys.includes(key)) problems.push(`${where}: unknown key "${key}"`)
  }
  known(plan, ['kind', 'version', 'app', 'domain', 'tenants', 'dir', 'port', 'proxy', 'envFiles', 'docker', 'bootstrap', 'tool'], 'plan')
  if (plan['kind'] !== PLAN_KIND || plan['version'] !== 1) problems.push(`not a version-1 ${PLAN_KIND}`)
  const app = typeof plan['app'] === 'string' && APP_NAME.test(plan['app']) ? plan['app'] : undefined
  if (!app) problems.push('app is not an app name')
  if (typeof plan['domain'] !== 'string' || !DOMAIN.test(plan['domain'])) problems.push('domain is not a lowercase host name')
  if (plan['tenants'] !== 'subdomain' && plan['tenants'] !== 'none') problems.push('tenants is subdomain or none')
  const dir = plan['dir']
  if (typeof dir !== 'string' || !dir.startsWith('/') || dir === '/' || normalize(dir) !== dir || dir.endsWith('/') || /[\0\n\r"'\\$`\s]/.test(dir)) {
    problems.push('dir must be an absolute, normalized path without quotes, spaces or shell characters (not /)')
  }
  const port = plan['port']
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) problems.push('port must be a port number')
  if (typeof plan['docker'] !== 'boolean') problems.push('docker must be true or false')
  if (typeof plan['tool'] !== 'string' || !VERSION.test(plan['tool'])) problems.push('tool must be a version')

  const files = plan['envFiles']
  if (!Array.isArray(files) || files.length > 8) problems.push('envFiles must be a list (at most 8)')
  else {
    for (const file of files) {
      const problem = typeof file === 'string' && file.startsWith('/') && app ? envLocationProblem(app, file) : `"${String(file)}" must be an absolute path in /etc/${app ?? '<app>'}/`
      if (problem) problems.push(`envFiles: ${problem}`)
    }
  }

  const bootstrap = plan['bootstrap']
  if (bootstrap !== undefined) {
    if (typeof bootstrap !== 'object' || bootstrap === null || Array.isArray(bootstrap)) problems.push('bootstrap must be an object')
    else {
      const b = bootstrap as Record<string, unknown>
      known(b, ['swapGb', 'firewall'], 'bootstrap')
      if (b['swapGb'] !== undefined && (typeof b['swapGb'] !== 'number' || !Number.isInteger(b['swapGb']) || b['swapGb'] < 0 || b['swapGb'] > 64)) problems.push('bootstrap.swapGb must be a whole number from 0 to 64')
      if (b['firewall'] !== undefined && typeof b['firewall'] !== 'boolean') problems.push('bootstrap.firewall must be true or false')
    }
  }

  const proxy = (typeof plan['proxy'] === 'object' && plan['proxy'] !== null ? plan['proxy'] : {}) as Record<string, unknown>
  const kind = proxy['kind']
  if (kind === 'none') known(proxy, ['kind'], 'proxy')
  else if (kind === 'apache' || kind === 'caddy') {
    known(proxy, kind === 'apache'
      ? ['kind', 'managed', 'vhost', 'webRoot', 'apiPrefix', 'certName', 'root']
      : ['kind', 'managed', 'webRoot', 'apiPrefix', 'onDemandTls', 'extra', 'root'], 'proxy')
    if (typeof proxy['managed'] !== 'boolean') problems.push('proxy.managed must be true or false')
    // Unmanaged, root writes no site: the two fields go nowhere, but they stay strings.
    const managed = proxy['managed'] !== false
    if (managed ? !isWebRoot(proxy['webRoot']) : typeof proxy['webRoot'] !== 'string') problems.push('proxy.webRoot must be a directory inside the checkout (no dot directories, not the checkout itself)')
    if (managed ? typeof proxy['apiPrefix'] !== 'string' || !API_PREFIX.test(proxy['apiPrefix']) : typeof proxy['apiPrefix'] !== 'string') problems.push('proxy.apiPrefix must be a URL path such as /api')
    if (proxy['root'] !== undefined && !isConfigRoot(proxy['root'])) problems.push('proxy.root must be an absolute directory')
    if (kind === 'apache') {
      const vhost = vhostFileProblem(app ?? '', proxy['vhost'])
      if (vhost) problems.push(`proxy.vhost ${vhost}`)
      if (proxy['certName'] !== undefined && (typeof proxy['certName'] !== 'string' || !CERT_NAME.test(proxy['certName']))) problems.push('proxy.certName is not a certificate name')
    } else {
      const ask = proxy['onDemandTls']
      if (ask !== undefined && (typeof ask !== 'object' || ask === null || typeof (ask as { ask?: unknown }).ask !== 'string' || !ASK_PATH.test((ask as { ask: string }).ask) || Object.keys(ask).length !== 1)) {
        problems.push('proxy.onDemandTls must be { ask: "/path" }')
      }
      const extra = proxy['extra'] === undefined ? undefined : caddyExtraProblem(proxy['extra'])
      if (extra) problems.push(`proxy.extra ${extra}`)
    }
  } else problems.push('proxy.kind is apache, caddy or none')

  if (problems.length > 0) throw new DeployError(`${source} is refused:\n${problems.map((p) => `      - ${p}`).join('\n')}`)
  return value as InstallPlan
}

/** Reads a plan as root: no symlink followed, a regular file, 64 KiB at most. */
export async function readInstallPlan(host: Host, path: string): Promise<InstallPlan> {
  let text: string
  try {
    text = await host.readPlainFile(path, MAX_PLAN_BYTES)
  } catch (error) {
    throw new DeployError(`--plan=${path}: ${(error as Error).message}`)
  }
  return parseInstallPlan(text, path)
}

// ── root's half ────────────────────────────────────────────────────────────

export interface InstallOptions {
  /** Where the state directories live. @default '/var/lib/basalt' */
  stateRoot?: string
}

interface Account { name: string; uid: number; gid: number }

async function account(host: Host, user: string): Promise<Account> {
  const uid = await host.exec('id', ['-u', user])
  const gid = await host.exec('id', ['-g', user])
  const u = Number(uid.stdout.trim())
  const g = Number(gid.stdout.trim())
  if (uid.code !== 0 || gid.code !== 0 || !Number.isInteger(u) || !Number.isInteger(g)) throw new DeployError(`no user ${user} on this server`)
  if (u === 0) throw new DeployError(`${user} is uid 0: install needs the unprivileged user the deploys run as`)
  return { name: user, uid: u, gid: g }
}

/** The DeployContext the proxy writers read: built from the plan's fields only. */
function contextOf(host: Host, plan: InstallPlan, stateDir: string): DeployContext {
  const proxy: DeployConfig['proxy'] = plan.proxy.kind === 'apache'
    ? ({ ...plan.proxy } as ApacheProxy)
    : plan.proxy.kind === 'caddy'
      ? ({ ...plan.proxy } as CaddyProxy)
      : { kind: 'none' }
  const config: DeployConfig = {
    app: plan.app, domain: plan.domain, tenants: plan.tenants, env: {},
    runtime: { kind: 'pm2', script: 'start', port: plan.port, avoid: [] },
    proxy,
  }
  return { config, dir: plan.dir, host, pm: 'pnpm', envPath: '', stateDir }
}

/**
 * `sudo … basalt-deploy install --plan=<file>` — once per server, by an
 * administrator, with a copy of this tool root owns (never the checkout's
 * node_modules). Everything that needs root and nothing else.
 */
export async function install(host: Host, plan: InstallPlan, user: string | undefined, options: InstallOptions = {}): Promise<number> {
  if (host.uid() !== 0) throw new DeployError('install needs root: sudo, with a copy of @basaltkit/deploy root owns (see install-plan)')
  if (!user || user === 'root') throw new DeployError('install needs the unprivileged user the deploys run as: --user=<name> (never root)')
  if (!USER_NAME.test(user)) throw new DeployError(`--user=${user} is not a login name`)
  // Validated again: a plan built in code may not have come through readInstallPlan.
  parseInstallPlan(JSON.stringify(plan), 'the plan')
  const owner = await account(host, user)

  // The checkout is the user's own directory — the web root is served from it.
  const checkout = await host.stat(plan.dir)
  if (checkout?.kind !== 'dir') throw new DeployError(`${plan.dir} is not a directory (a symbolic link is refused)`)
  if (checkout.uid !== owner.uid) throw new DeployError(`${plan.dir} is not ${user}'s (uid ${checkout.uid}): install serves ${user}'s checkout only`)

  const stateRoot = options.stateRoot ?? '/var/lib/basalt'
  await host.mkdir(stateRoot, 0o755)
  await assertRootOwnedDir(host, stateRoot, 'state directory')
  const stateDir = join(stateRoot, plan.app)
  const backups = join(stateRoot, `${plan.app}.install-backups`)
  host.out.step(`state directory ${stateDir}`)
  await refuseForeign(host, stateDir, owner, 'the state directory')
  await host.mkdir(stateDir, 0o700)
  await secure(host, stateDir, { uid: owner.uid, gid: owner.gid, mode: 0o700, kind: 'dir' })
  // Root's own: the copies of the proxy files it replaces. Not in stateDir, which the user owns.
  await host.mkdir(backups, 0o700)
  await secure(host, backups, { uid: 0, gid: 0, mode: 0o700, kind: 'dir' })

  const release = await acquireLock(host, stateDir, 'install', host.env['SUDO_USER'] ?? 'root')
  const off = host.onSignal((signal) => host.out.warn(`${signal}: install cannot stop safely mid-way — it finishes, then exits (a second ${signal} stops it at once)`))
  try {
    host.out.ok(`${stateDir} (0700, owned by ${user}); the release history moves there on the next deploy`)
    const overrides = `/etc/basalt/${plan.app}.json`
    await host.mkdir('/etc/basalt', 0o755)
    await assertRootOwnedDir(host, '/etc/basalt', 'server overrides')
    if (!(await host.exists(overrides))) {
      await host.writeFile(overrides, '{}\n', 0o644)
      host.out.ok(`${overrides} created (server-local overrides, no secrets)`)
    }

    const ctx = contextOf(host, plan, stateDir)
    summary(host, plan, user, stateDir, ctx)
    await envOwnership(host, plan, owner)

    if (plan.proxy.kind === 'apache' && plan.proxy.managed) {
      const root = plan.proxy.root ?? '/etc/apache2'
      await confirmRoot(host, root, '/etc/apache2')
      for (const dir of [join(root, 'sites-available'), join(root, 'sites-enabled')]) await assertRootOwnedDir(host, dir, 'Apache')
      await refuseTakenNames(host, plan, [join(root, 'sites-available'), join(root, 'sites-enabled')], vhostPaths(ctx).file, 'apache')
      host.out.step(`Apache vhost ${vhostPaths(ctx).file}`)
      await apacheInstall(ctx, plan.port, backups)
    }
    if (plan.proxy.kind === 'caddy' && plan.proxy.managed) {
      const root = plan.proxy.root ?? '/etc/caddy'
      await confirmRoot(host, root, '/etc/caddy')
      await assertRootOwnedDir(host, root, 'Caddy')
      await refuseTakenNames(host, plan, [caddyPaths(ctx).dir], `${plan.app}.caddy`, 'caddy', caddyPaths(ctx).main)
      if (plan.proxy.extra !== undefined) await confirmExtra(host, plan.proxy.extra, caddyPaths(ctx).site)
      host.out.step(`Caddy site ${caddyPaths(ctx).site}`)
      await host.mkdir(caddyPaths(ctx).dir, 0o755)
      await assertRootOwnedDir(host, caddyPaths(ctx).dir, 'Caddy')
      await caddyInstall(ctx, plan.port, backups)
    }

    if (plan.docker) {
      const groups = (await host.exec('id', ['-nG', user])).stdout.split(/\s+/)
      if (groups.includes('docker')) {
        host.out.warn(`${user} is in the docker group: that is root on this machine (a container can mount /). Plan the move to rootless Docker for ${user} (dockerd-rootless-setuptool.sh install); this command will not do it for a server with data in rootful volumes.`)
      } else {
        host.out.info(`Docker for ${user}: rootless — dockerd-rootless-setuptool.sh install (as ${user}), then loginctl enable-linger ${user}`)
      }
    }
    host.out.ok(`installed — from now on, as ${user} (not root), in ${plan.dir}: ${RUN_COMMAND}`)
    return 0
  } finally {
    off()
    await release()
  }
}

/** What root is about to do, from the plan — said before anything is written. */
function summary(host: Host, plan: InstallPlan, user: string, stateDir: string, ctx: DeployContext): void {
  const names = [plan.domain, ...(plan.tenants === 'subdomain' ? [`*.${plan.domain}`] : [])].join(', ')
  const site = plan.proxy.kind === 'apache' && plan.proxy.managed
    ? `Apache ${vhostPaths(ctx).available} for ${names} → 127.0.0.1:${plan.port}, ${join(plan.dir, plan.proxy.webRoot)} served, certificate ${plan.proxy.certName ?? plan.domain}`
    : plan.proxy.kind === 'caddy' && plan.proxy.managed
      ? `Caddy ${caddyPaths(ctx).site} for ${names} → 127.0.0.1:${plan.port}, ${join(plan.dir, plan.proxy.webRoot)} served`
      : 'no proxy site'
  host.out.info(`install for "${plan.app}" (plan by @basaltkit/deploy ${plan.tool}), for ${user}, checkout ${plan.dir}:`)
  host.out.info(`  state ${stateDir} · ${site}${plan.envFiles.length ? ` · env ${plan.envFiles.join(', ')}` : ''}`)
}

/** The host names a proxy config file serves: Apache ServerName/ServerAlias, Caddy site addresses. */
export function servedNames(text: string, kind: 'apache' | 'caddy'): string[] {
  const clean = (name: string) => name.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, '').replace(/\.$/, '')
  if (kind === 'apache') {
    return [...text.matchAll(/^\s*Server(?:Name|Alias)\s+(.+)$/gim)].flatMap((m) => (m[1] ?? '').trim().split(/\s+/)).map(clean).filter(Boolean)
  }
  const names: string[] = []
  let depth = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (depth === 0 && line.endsWith('{') && line !== '{') {
      for (const address of line.slice(0, -1).split(/[\s,]+/)) {
        if (address && !address.startsWith('(') && !address.startsWith(':')) names.push(clean(address))
      }
    }
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
    if (depth < 0) depth = 0
  }
  return names.filter(Boolean)
}

const overlap = (a: string, b: string) => a === b || (a.startsWith('*.') && covers(a, b)) || (b.startsWith('*.') && covers(b, a))

/**
 * The plan's names are not another site's: a new file whose ServerName (or
 * Caddy address) is a co-hosted app's domain — or a more specific name under
 * its wildcard — would take that app's traffic and certificate.
 */
async function refuseTakenNames(host: Host, plan: InstallPlan, dirs: string[], own: string, kind: 'apache' | 'caddy', main?: string): Promise<void> {
  const ours = [plan.domain, ...(plan.tenants === 'subdomain' ? [`*.${plan.domain}`] : [])]
  const files = [...(main ? [main] : []), ...(await Promise.all(dirs.map(async (dir) => (await host.list(dir)).filter((name) => name !== own).map((name) => join(dir, name))))).flat()]
  for (const file of files) {
    const text = await host.readFile(file)
    if (text === undefined) continue
    const taken = servedNames(text, kind).filter((name) => ours.some((mine) => overlap(mine, name)))
    if (taken.length > 0) throw new DeployError(`refused: ${file} already serves ${[...new Set(taken)].join(', ')} — "${plan.app}" may not take another site's names (${ours.join(', ')})`)
  }
}

async function secure(host: Host, path: string, owner: { uid: number; gid: number; mode: number; kind: 'file' | 'dir' }): Promise<void> {
  try {
    await host.secureOwner(path, owner)
  } catch (error) {
    throw new DeployError(`refused: ${(error as Error).message}`)
  }
}

/**
 * An existing path install would hand to the app user: refused when another
 * account owns it — another app's state, its dumps, its secrets.
 */
async function refuseForeign(host: Host, path: string, owner: Account, what: string): Promise<void> {
  const stat = await host.stat(path)
  if (!stat || stat.uid === undefined || stat.uid === 0 || stat.uid === owner.uid) return
  throw new DeployError(`refused: ${what} ${path} belongs to uid ${stat.uid}, not ${owner.name} — another app's? Nothing is handed over from one account to another; name this app something else`)
}

/**
 * The env files in `/etc/<app>/` (deploys run as the app user and rewrite
 * them): the directory and each existing file become the user's, 0700/0600 —
 * through O_NOFOLLOW descriptors, so a link planted there is refused, never
 * followed (`ln -sf /etc/sudoers /etc/<app>/api.env` changes nothing).
 *
 * The app name chooses the directory, so it may name one that is not the
 * app's: install creates `/etc/<app>` or keeps it the user's; it never takes
 * one a Debian package ships, one another user owns, or one with
 * subdirectories, and it asks before taking one root made by hand.
 */
async function envOwnership(host: Host, plan: InstallPlan, owner: Account): Promise<void> {
  if (plan.envFiles.length === 0) return
  host.out.step('env files outside the checkout')
  const dir = `/etc/${plan.app}`
  await assertRootOwnedDir(host, '/etc', 'env files')
  for (const file of plan.envFiles) if (dirname(file) !== dir) throw new DeployError(`refused: ${file} is not directly in ${dir}`)
  const existing = await host.stat(dir)
  if (existing) {
    if ((await host.exec('dpkg-query', ['-S', dir])).code === 0) throw new DeployError(`refused: ${dir} belongs to an installed package — it is not the app's to own; keep the env inside the checkout, or name the app something else`)
    await refuseForeign(host, dir, owner, 'the env directory')
    if (existing.kind === 'dir' && existing.uid === 0) {
      const entries = await host.list(dir)
      const kinds = await Promise.all(entries.map(async (name) => ({ name, stat: await host.stat(join(dir, name)) })))
      const odd = kinds.filter((e) => e.stat?.kind !== 'file').map((e) => e.name)
      if (odd.length > 0) throw new DeployError(`refused: ${dir} holds ${odd.join(', ')} (not plain files) — an app's env directory holds env files only`)
      host.out.warn(`${dir} exists and is root's${entries.length ? ` (${entries.join(', ')})` : ''}: install would give it and the env files to ${owner.name}`)
      if (!(await host.confirm(`Give ${dir} to ${owner.name}?`))) throw new DeployError(`${dir} not handed over (not confirmed) — nothing else was changed there (a terminal must answer)`)
    }
  } else {
    await host.mkdir(dir, 0o700)
  }
  await secure(host, dir, { uid: owner.uid, gid: owner.gid, mode: 0o700, kind: 'dir' })
  for (const file of plan.envFiles) {
    if (!(await host.stat(file))) { host.out.info(`${file} does not exist yet — the first env or run creates it`); continue }
    await refuseForeign(host, file, owner, 'the env file')
    await secure(host, file, { uid: owner.uid, gid: owner.gid, mode: 0o600, kind: 'file' })
  }
  host.out.ok(`${dir} and its env files (${plan.envFiles.map((f) => basename(f)).join(', ')}) owned by ${owner.name}, 0700/0600`)
}

/** A config root other than the package's default: shown, and written only after a "yes". */
async function confirmRoot(host: Host, root: string, standard: string): Promise<void> {
  if (root === standard) return
  host.out.warn(`the plan asks to write proxy configuration under ${root}, not ${standard}`)
  if (!(await host.confirm(`Write under ${root}?`))) throw new DeployError(`proxy root ${root} not confirmed — nothing written (a terminal must answer)`)
}

/** Caddy `extra` is raw configuration root installs: shown in full, and written only after a "yes". */
async function confirmExtra(host: Host, extra: string, site: string): Promise<void> {
  host.out.info(`proxy.extra — raw Caddyfile appended to ${site}, as written by the app user (tabs shown as →):`)
  // parseInstallPlan refused every character a terminal would hide text with.
  for (const line of extra.trim().split('\n')) host.out.info(`  + ${line.replace(/\t/g, '→   ')}`)
  if (!(await host.confirm('Install this raw configuration as root?'))) throw new DeployError('proxy.extra not confirmed — nothing written (a terminal must answer)')
}
