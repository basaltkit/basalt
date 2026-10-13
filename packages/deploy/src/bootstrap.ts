import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { below, lockedPnpm, minimumVersion } from './checks.js'
import { DeployError } from './context.js'
import type { Host } from './host.js'
import { install, parseInstallPlan } from './install-plan.js'
import { USER_NAME } from './trust.js'

/**
 * `basalt-deploy bootstrap` — a fresh Ubuntu/Debian server, once (RFC 0007 §7).
 * Root, with a copy of this tool root owns (`sudo -H npx --yes
 * --package=@basaltkit/deploy@<exact version> -- basalt-deploy bootstrap`, run
 * from outside the checkout): it never loads deploy.config.ts nor runs the
 * checkout's node_modules — both are the app user's to change. Three phases:
 *
 *   1. the system: base packages · Docker + compose · Node at engines.node ·
 *      the pnpm the lockfile records · the checkout and the docker group for
 *      the user;
 *   2. as the user, in the checkout: `pnpm install`, `env` (it may ask), then
 *      `install-plan`, whose JSON comes back as data;
 *   3. as root, from that plan: swap (< 6 GB RAM), ufw (only when nothing but
 *      SSH listens), Caddy (proxy: caddy), then `install`.
 *
 * `--dry-run` prints every command and runs none (phase 3 then assumes
 * `--proxy`, or none: the plan is not written in a dry run).
 */

export interface BootstrapOptions {
  user: string | undefined
  /** Overrides the plan's proxy (and decides phase 3 of a dry run). */
  proxy?: 'apache' | 'caddy' | 'none'
  /** Overrides the plan's `bootstrap.swapGb` (default 4). */
  swapGb?: number
  /** Overrides the plan's `bootstrap.firewall` (default on). */
  firewall?: boolean
  dryRun: boolean
}

export interface Action {
  what: string
  commands: string[][]
  /** Run in this directory (the checkout, for the user's steps); default outside it. */
  cwd?: string
  /** The command may ask at the terminal (`env`). */
  interactive?: boolean
}

const APT = ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get']
const OUTSIDE = { cwd: tmpdir() }
const BIN = 'node_modules/@basaltkit/deploy/dist/bin.js'

const sh = (script: string) => ['sh', '-c', script]
const has = async (host: Host, command: string) => (await host.exec('sh', ['-c', `command -v ${command}`], OUTSIDE)).code === 0

/** Phase 1 — what the system lacks. Pure planning: probes only. */
export async function planSystem(host: Host, dir: string, user: string): Promise<{ actions: Action[]; notes: string[] }> {
  const actions: Action[] = []
  const notes: string[] = []
  if (!(await has(host, 'apt-get'))) throw new DeployError('bootstrap installs with apt: Ubuntu or Debian only')

  const packages: string[] = []
  for (const name of ['ca-certificates', 'curl', 'git', 'openssl', 'gnupg']) {
    if ((await host.exec('dpkg', ['-s', name], OUTSIDE)).code !== 0) packages.push(name)
  }
  if (packages.length) actions.push({ what: `packages: ${packages.join(', ')}`, commands: [[...APT, 'update', '-qq'], [...APT, 'install', '-y', '-qq', ...packages]] })

  if ((await host.exec('docker', ['compose', 'version'], OUTSIDE)).code !== 0) {
    actions.push({
      what: 'Docker + compose (download.docker.com)',
      commands: [
        ['install', '-m', '0755', '-d', '/etc/apt/keyrings'],
        sh('curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc'),
        sh('echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list'),
        [...APT, 'update', '-qq'],
        [...APT, 'install', '-y', '-qq', 'docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'],
        ['systemctl', 'enable', '--now', 'docker'],
      ],
    })
  }

  // package.json and the lockfile as data: versions matched by pattern, nothing evaluated.
  let pkg: { engines?: { node?: string }; packageManager?: string } = {}
  try { pkg = JSON.parse((await host.readFile(join(dir, 'package.json'))) ?? '{}') as typeof pkg } catch { /* reported by run's C9 */ }
  const wanted = minimumVersion(pkg.engines?.node)
  const node = minimumVersion((await host.exec('node', ['--version'], OUTSIDE)).stdout)
  if (!node || (wanted && below(node, wanted))) {
    // §11.1: NodeSource — it updates with apt. The current LTS line, or the engines' major if newer.
    const major = Math.max(24, wanted?.[0] ?? 0)
    actions.push({ what: `Node ${major} (NodeSource; engines.node ${pkg.engines?.node ?? 'unset'})`, commands: [sh(`curl -fsSL https://deb.nodesource.com/setup_${major}.x | bash -`), [...APT, 'install', '-y', '-qq', 'nodejs']] })
  }

  if (pkg.packageManager?.startsWith('pnpm@')) {
    // The lockfile's own pnpm when it records one (C11), else packageManager's.
    const lockfile = await host.readFile(join(dir, 'pnpm-lock.yaml'))
    const version = (lockfile && lockedPnpm(lockfile)) ?? pkg.packageManager.slice('pnpm@'.length).split('+')[0] as string
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new DeployError(`the pnpm version the project records ("${version}") is not a version`)
    const current = (await host.exec('pnpm', ['--version'], OUTSIDE)).stdout.trim()
    if (current !== version) actions.push({ what: `pnpm ${version}${current ? ` (this server has ${current})` : ''}`, commands: [['npm', 'install', '-g', `pnpm@${version}`]] })
  }

  const owner = (await host.exec('stat', ['-c', '%U', dir], OUTSIDE)).stdout.trim()
  if (owner !== user) actions.push({ what: `${dir} owned by ${user}`, commands: [['chown', '-R', `${user}:`, dir]] })
  const groups = (await host.exec('id', ['-nG', user], OUTSIDE)).stdout.split(/\s+/)
  if (!groups.includes('docker')) {
    // §11.2: the docker group, said plainly — rootless Docker is its own phase.
    actions.push({ what: `${user} in the docker group`, commands: [['usermod', '-aG', 'docker', user]] })
    notes.push(`${user} is now in the docker group — that is root on this machine (a container can mount /). Rootless Docker is a later step; it moves every volume.`)
  }
  return { actions, notes }
}

/** Phase 2 — as the user, in the checkout: argv only (no shell), the directory as the working directory. */
export function userSteps(user: string, dir: string): Action[] {
  const asUser = (...command: string[]) => ['sudo', '-u', user, '-H', '--', ...command]
  return [
    { what: `as ${user}: dependencies`, cwd: dir, commands: [asUser('env', '-u', 'NODE_ENV', 'pnpm', 'install', '--frozen-lockfile')] },
    { what: `as ${user}: the .env (asks what it cannot generate)`, cwd: dir, interactive: true, commands: [asUser('node', BIN, 'env')] },
  ]
}

/** The phase-2 command whose stdout is the install plan (JSON). */
export const planCommand = (user: string) => ['sudo', '-u', user, '-H', '--', 'node', BIN, 'install-plan', '--out=-']

/** Phase 3 — swap, ufw, Caddy, from the plan (or the flags). */
export async function planServer(host: Host, options: { proxy: 'apache' | 'caddy' | 'none'; swapGb: number; firewall: boolean }): Promise<{ actions: Action[]; notes: string[] }> {
  const actions: Action[] = []
  const notes: string[] = []
  const meminfo = (await host.readFile('/proc/meminfo')) ?? ''
  const memGb = Number(/MemTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0) / 1024 / 1024
  const swapKb = Number(/SwapTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0)
  if (options.swapGb > 0 && meminfo && memGb < 6 && swapKb === 0 && !(await host.exists('/swapfile'))) {
    actions.push({
      what: `swap ${options.swapGb} GB (${memGb.toFixed(1)} GB RAM, none yet)`,
      commands: [['fallocate', '-l', `${options.swapGb}G`, '/swapfile'], ['chmod', '600', '/swapfile'], ['mkswap', '/swapfile'], ['swapon', '/swapfile'], sh("grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab")],
    })
  }

  if (options.firewall && (await has(host, 'ufw'))) {
    // SSH_CONNECTION = "client-ip client-port server-ip server-port": split, not a regex over input.
    const sshPort = (host.env['SSH_CONNECTION'] ?? '').trim().split(/\s+/)[3]
    const ssh = sshPort && /^\d+$/.test(sshPort) ? sshPort : '22'
    const web = options.proxy === 'none' ? [] : [['ufw', 'allow', '80/tcp'], ['ufw', 'allow', '443/tcp']]
    const active = (await host.exec('ufw', ['status'], OUTSIDE)).stdout.includes('Status: active')
    if (active) {
      actions.push({ what: `ufw: SSH (${ssh})${web.length ? ', 80, 443' : ''} allowed`, commands: [['ufw', 'allow', `${ssh}/tcp`], ...web] })
    } else {
      // Turning ufw ON is safe on a fresh machine only: on a shared one it cuts every service not listed.
      // ss -ltnH: "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*" — the 4th column is the local address.
      const listening = (await host.exec('ss', ['-ltnH'], OUTSIDE)).stdout.split('\n')
        .map((l) => l.trim().split(/\s+/)[3] ?? '')
        .filter((local) => local.includes(':') && !/^(127\.|\[::1\]|::1)/.test(local))
        .map((local) => local.slice(local.lastIndexOf(':') + 1))
      const others = [...new Set(listening.filter((p) => p !== ssh))]
      if (others.length) notes.push(`ufw is off and ports ${others.join(', ')} listen: not turned on, so nothing is cut off — configure it by hand`)
      else actions.push({ what: `ufw on: SSH (${ssh})${web.length ? ', 80, 443' : ''} only`, commands: [['ufw', 'allow', `${ssh}/tcp`], ...web, ['ufw', '--force', 'enable']] })
    }
  }

  if (options.proxy === 'caddy' && !(await has(host, 'caddy'))) {
    actions.push({
      what: 'Caddy (cloudsmith)',
      commands: [
        [...APT, 'install', '-y', '-qq', 'debian-keyring', 'debian-archive-keyring', 'apt-transport-https'],
        sh("curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"),
        sh("curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list"),
        [...APT, 'update', '-qq'],
        [...APT, 'install', '-y', '-qq', 'caddy'],
      ],
    })
  }
  return { actions, notes }
}

/** Every phase as a dry run shows it: phase 3 with the flags (the plan does not exist yet). */
export async function planBootstrap(host: Host, dir: string, options: BootstrapOptions): Promise<{ actions: Action[]; notes: string[] }> {
  const user = options.user as string
  const system = await planSystem(host, dir, user)
  const server = await planServer(host, { proxy: options.proxy ?? 'none', swapGb: options.swapGb ?? 4, firewall: options.firewall ?? true })
  return {
    actions: [
      ...system.actions,
      ...userSteps(user, dir),
      { what: `as ${user}: the install plan (data only)`, cwd: dir, commands: [planCommand(user)] },
      ...server.actions,
      { what: 'install (root, from the plan): state directory, the proxy site, env ownership', commands: [] },
    ],
    notes: [...system.notes, ...server.notes],
  }
}

/** The @basaltkit/deploy version the lockfile records — what root should be running. */
export function lockedDeployVersion(lockfile: string): string | undefined {
  return /['"]?@basaltkit\/deploy@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)['"]?:/.exec(lockfile)?.[1]
}

async function runActions(host: Host, actions: Action[], dryRun: boolean): Promise<void> {
  for (const action of actions) {
    host.out.info(action.what)
    for (const command of action.commands) {
      host.out.info(`  + ${command.join(' ')}${action.cwd ? `   (in ${action.cwd})` : ''}`)
      if (dryRun) continue
      const result = await host.exec(command[0] as string, command.slice(1), {
        cwd: action.cwd ?? OUTSIDE.cwd,
        ...(action.interactive ? { interactive: true } : { stream: true }),
      })
      if (result.code !== 0) throw new DeployError(`${action.what}: \`${command.join(' ')}\` failed (exit ${result.code}) — re-run bootstrap after fixing it; what is done is not redone`)
    }
    if (!dryRun && action.commands.length) host.out.ok(action.what)
  }
}

export async function bootstrap(host: Host, dir: string, options: BootstrapOptions, tool?: string): Promise<number> {
  const user = options.user
  if (!user || user === 'root') throw new DeployError('bootstrap needs the unprivileged user the deploys will run as: --user=<name> (never root)')
  if (!USER_NAME.test(user)) throw new DeployError(`--user=${user} is not a login name`)
  if (!options.dryRun && host.uid() !== 0) throw new DeployError('bootstrap installs packages: run it with sudo (or --dry-run to see what it would do)')
  if ((await host.exec('id', ['-u', user], OUTSIDE)).code !== 0) throw new DeployError(`no user ${user} on this server: adduser ${user} first`)

  host.out.step(`bootstrap${options.dryRun ? ' — dry run, nothing below runs' : ''}`)
  const locked = lockedDeployVersion((await host.readFile(join(dir, 'pnpm-lock.yaml'))) ?? '')
  if (tool && locked && locked !== tool) host.out.warn(`this is @basaltkit/deploy ${tool}; the lockfile records ${locked} — run the version the app deploys with (npx --package=@basaltkit/deploy@${locked})`)

  const system = await planSystem(host, dir, user)
  await runActions(host, [...system.actions, ...userSteps(user, dir)], options.dryRun)

  if (options.dryRun) {
    const { actions, notes } = await planBootstrap(host, dir, options)
    await runActions(host, actions.slice(system.actions.length + userSteps(user, dir).length), true)
    host.out.info(`(phase 3 above assumes proxy ${options.proxy ?? 'none'}: a real run takes it from the install plan)`)
    for (const note of notes) host.out.warn(note)
    return 0
  }

  // The plan comes back as data; root parses and validates it, never runs it.
  const command = planCommand(user)
  host.out.info(`as ${user}: the install plan\n      + ${command.join(' ')}`)
  const written = await host.exec(command[0] as string, command.slice(1), { cwd: dir })
  if (written.code !== 0) throw new DeployError(`install-plan as ${user} failed (exit ${written.code}): ${written.stderr.trim().split('\n').slice(-3).join(' ')}`)
  const plan = parseInstallPlan(written.stdout, `the install plan from ${user}`)
  if (plan.dir !== dir) throw new DeployError(`the install plan names ${plan.dir}, not ${dir} — refused`)

  const server = await planServer(host, {
    proxy: options.proxy ?? plan.proxy.kind,
    swapGb: options.swapGb ?? plan.bootstrap?.swapGb ?? 4,
    firewall: options.firewall ?? plan.bootstrap?.firewall ?? true,
  })
  await runActions(host, server.actions, false)
  await install(host, plan, user)
  for (const note of [...system.notes, ...server.notes]) host.out.warn(note)
  host.out.ok(`server ready — from now on, as ${user} in ${dir}: node ${BIN} run`)
  return 0
}
