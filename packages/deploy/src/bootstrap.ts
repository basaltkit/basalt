import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { below, lockedPnpm, minimumVersion } from './checks.js'
import { DeployError } from './context.js'
import type { Host } from './host.js'

/**
 * `basalt-deploy bootstrap` — a fresh Ubuntu/Debian server, once (RFC 0007 §7).
 * Root. Installs only what is missing, then hands over to the app user:
 *
 *   base packages · Docker + compose · Node at engines.node · the pnpm the
 *   lockfile records · swap (< 6 GB RAM) · ufw (only when nothing but SSH
 *   listens) · Caddy (proxy: caddy) · the checkout and the docker group for
 *   the user · then, as the user, `pnpm install` and `env`, and as root,
 *   `install`.
 *
 * It needs no node_modules and no loaded config: it runs before either exists
 * (`sudo npx -y -p @basaltkit/deploy basalt-deploy bootstrap --user=<u>`), so it
 * reads package.json and takes the proxy and swap from flags.
 *
 * `--dry-run` prints every command and runs none.
 */

export interface BootstrapOptions {
  user: string | undefined
  proxy: 'apache' | 'caddy' | 'none'
  swapGb: number
  firewall: boolean
  dryRun: boolean
}

interface Action {
  what: string
  commands: string[][]
}

const APT = ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get']
const OUTSIDE = { cwd: tmpdir() }

/** What a fresh server needs, given what is already there. Pure planning: it runs probes, never changes anything. */
export async function planBootstrap(host: Host, dir: string, options: BootstrapOptions): Promise<{ actions: Action[]; notes: string[] }> {
  const actions: Action[] = []
  const notes: string[] = []
  const sh = (script: string) => ['sh', '-c', script]
  const has = async (command: string) => (await host.exec('sh', ['-c', `command -v ${command}`], OUTSIDE)).code === 0

  if (!(await has('apt-get'))) throw new DeployError('bootstrap installs with apt: Ubuntu or Debian only')

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
    const current = (await host.exec('pnpm', ['--version'], OUTSIDE)).stdout.trim()
    if (current !== version) actions.push({ what: `pnpm ${version}${current ? ` (this server has ${current})` : ''}`, commands: [['npm', 'install', '-g', `pnpm@${version}`]] })
  }

  const meminfo = (await host.readFile('/proc/meminfo')) ?? ''
  const memGb = Number(/MemTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0) / 1024 / 1024
  const swapKb = Number(/SwapTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0)
  if (options.swapGb > 0 && meminfo && memGb < 6 && swapKb === 0 && !(await host.exists('/swapfile'))) {
    actions.push({
      what: `swap ${options.swapGb} GB (${memGb.toFixed(1)} GB RAM, none yet)`,
      commands: [['fallocate', '-l', `${options.swapGb}G`, '/swapfile'], ['chmod', '600', '/swapfile'], ['mkswap', '/swapfile'], ['swapon', '/swapfile'], sh("grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab")],
    })
  }

  if (options.firewall && (await has('ufw'))) {
    const ssh = /\S+\s+\S+\s+\S+\s+(\d+)/.exec(host.env['SSH_CONNECTION'] ?? '')?.[1] ?? '22'
    const web = options.proxy === 'none' ? [] : [['ufw', 'allow', '80/tcp'], ['ufw', 'allow', '443/tcp']]
    const active = (await host.exec('ufw', ['status'], OUTSIDE)).stdout.includes('Status: active')
    if (active) {
      actions.push({ what: `ufw: SSH (${ssh})${web.length ? ', 80, 443' : ''} allowed`, commands: [['ufw', 'allow', `${ssh}/tcp`], ...web] })
    } else {
      // Turning ufw ON is safe on a fresh machine only: on a shared one it cuts every service not listed.
      const listening = (await host.exec('ss', ['-ltnH'], OUTSIDE)).stdout.split('\n')
        .map((l) => /\s(\S+):(\d+)\s/.exec(l)).filter((m): m is RegExpExecArray => m !== null)
        .filter((m) => !/^(127\.|\[::1\]|::1)/.test(m[1] as string)).map((m) => m[2] as string)
      const others = [...new Set(listening.filter((p) => p !== ssh))]
      if (others.length) notes.push(`ufw is off and ports ${others.join(', ')} listen: not turned on, so nothing is cut off — configure it by hand`)
      else actions.push({ what: `ufw on: SSH (${ssh})${web.length ? ', 80, 443' : ''} only`, commands: [['ufw', 'allow', `${ssh}/tcp`], ...web, ['ufw', '--force', 'enable']] })
    }
  }

  if (options.proxy === 'caddy' && !(await has('caddy'))) {
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

  const user = options.user as string
  const owner = (await host.exec('stat', ['-c', '%U', dir], OUTSIDE)).stdout.trim()
  if (owner !== user) actions.push({ what: `${dir} owned by ${user}`, commands: [['chown', '-R', `${user}:`, dir]] })
  const groups = (await host.exec('id', ['-nG', user], OUTSIDE)).stdout.split(/\s+/)
  if (!groups.includes('docker')) {
    // §11.2: the docker group, said plainly — rootless Docker is its own phase.
    actions.push({ what: `${user} in the docker group`, commands: [['usermod', '-aG', 'docker', user]] })
    notes.push(`${user} is now in the docker group — that is root on this machine (a container can mount /). Rootless Docker is a later step; it moves every volume.`)
  }

  // As the user, from the checkout: the project's own tools from here on.
  const asUser = (...command: string[]) => ['sudo', '-u', user, '-H', '--', ...command]
  actions.push({
    what: `as ${user}: dependencies, then the .env (asks what it cannot generate)`,
    commands: [
      asUser('env', '-u', 'NODE_ENV', 'sh', '-c', `cd '${dir}' && pnpm install --frozen-lockfile`),
      asUser('sh', '-c', `cd '${dir}' && node node_modules/@basaltkit/deploy/dist/bin.js env`),
    ],
  })
  actions.push({ what: 'install (root): state directory, the proxy site, env ownership', commands: [['sh', '-c', `cd '${dir}' && node node_modules/@basaltkit/deploy/dist/bin.js install --user=${user}`]] })
  return { actions, notes }
}

export async function bootstrap(host: Host, dir: string, options: BootstrapOptions): Promise<number> {
  if (!options.user || options.user === 'root') throw new DeployError('bootstrap needs the unprivileged user the deploys will run as: --user=<name> (never root)')
  if (!options.dryRun && host.uid() !== 0) throw new DeployError('bootstrap installs packages: run it with sudo (or --dry-run to see what it would do)')
  if ((await host.exec('id', ['-u', options.user], OUTSIDE)).code !== 0) throw new DeployError(`no user ${options.user} on this server: adduser ${options.user} first`)

  host.out.step(`bootstrap${options.dryRun ? ' — dry run, nothing below runs' : ''}`)
  const { actions, notes } = await planBootstrap(host, dir, options)
  for (const action of actions) {
    host.out.info(action.what)
    for (const command of action.commands) {
      host.out.info(`  + ${command.join(' ')}`)
      if (options.dryRun) continue
      const result = await host.exec(command[0] as string, command.slice(1), { stream: true })
      if (result.code !== 0) throw new DeployError(`${action.what}: \`${command.join(' ')}\` failed (exit ${result.code}) — re-run bootstrap after fixing it; what is done is not redone`)
    }
    if (!options.dryRun) host.out.ok(action.what)
  }
  for (const note of notes) host.out.warn(note)
  if (!options.dryRun) host.out.ok(`server ready — from now on, as ${options.user} in ${dir}: node node_modules/@basaltkit/deploy/dist/bin.js run`)
  return 0
}
