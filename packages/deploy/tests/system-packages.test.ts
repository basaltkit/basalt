/**
 * `system.packages` (RFC 0007 §12): the app user checks them (C12, before the
 * build) and prints the fix; root — bootstrap and install — installs the
 * missing ones from the install plan's list, as argv, never through a shell.
 */
import { describe, expect, it } from 'vitest'
import { bootstrap, planBootstrap } from '../src/bootstrap.js'
import { DeployConfigError, validateConfig } from '../src/config.js'
import { DeployError } from '../src/context.js'
import { buildInstallPlan, install, parseInstallPlan, PLAN_KIND, type InstallPlan } from '../src/install-plan.js'
import { plan, preflight, run } from '../src/pipeline.js'
import { GOOD_ENV, OLD, server } from './acme-server.js'
import { acmeConfig, context, DIR, FakeHost, fail, ok, type Call } from './fake-host.js'

const PACKAGES = ['tesseract-ocr', 'tesseract-ocr-por', 'poppler-utils', 'unzip']
const config = (packages: string[] = PACKAGES) => acmeConfig({ backup: { beforeMigrate: false }, system: { packages } })

/**
 * dpkg-query as Debian answers it: the status for an installed package, exit 1
 * for one it does not know. `apt-get install` (through `env`) installs.
 */
function dpkg(host: FakeHost, installed: Set<string>): FakeHost {
  host.handlers.unshift(({ command, args }) => {
    if (command !== 'dpkg-query' || args[0] !== '-W') return undefined
    const name = args[2] as string
    return installed.has(name) ? ok('install ok installed') : fail(`dpkg-query: no packages found matching ${name}`, 1)
  })
  host.handlers.unshift(({ command, args }) => {
    if (command !== 'env' || args[1] !== 'apt-get') return undefined
    if (args[2] === 'install') for (const name of args.slice(3).filter((a) => !a.startsWith('-'))) installed.add(name)
    return ok()
  })
  return host
}

const probes = (host: FakeHost) => host.calls.filter((c) => c.command === 'dpkg-query' && c.args[0] === '-W')
const apt = (host: FakeHost) => host.calls.filter((c) => c.command === 'env' && c.args[1] === 'apt-get').map((c) => c.args.join(' '))
/** No package name ever went through a shell. */
const noShell = (calls: Call[]) => calls.filter((c) => c.command === 'sh' || c.command === 'bash').filter((c) => PACKAGES.some((p) => c.args.join(' ').includes(p)))

describe('system.packages in deploy.config.ts', () => {
  it('names only: never an option, a version, a release, a glob or shell syntax; each once', () => {
    for (const name of ['-oAPT::Get::AllowUnauthenticated=1', '--reinstall', 'unzip;id', '$(id)', 'un zip', 'Unzip', 'unzip=6.0-28', 'unzip/bookworm', 'unzi*', 'x', '../x', 'a'.repeat(64), '']) {
      expect(() => validateConfig(config([name])), JSON.stringify(name)).toThrow(DeployConfigError)
    }
    expect(() => validateConfig(config(['unzip', 'unzip']))).toThrow(/each package once/)
    expect(() => validateConfig(acmeConfig({ system: { packages: 'unzip' as never } }))).toThrow(/list of apt package names/)
    expect(validateConfig(config([...PACKAGES, 'libstdc++6', 'g++', 'python3.12'])).system?.packages).toHaveLength(7)
    expect(() => validateConfig(acmeConfig({ system: {} }))).not.toThrow()
  })
})

describe('C12, as the app user', () => {
  it('a missing package is an error with the exact fix; the run stops before anything is built', async () => {
    const { host, head } = server({ env: GOOD_ENV })
    dpkg(host, new Set(['tesseract-ocr', 'tesseract-ocr-por']))
    const ctx = context(host, config())
    const found = (await preflight(ctx)).findings.filter((f) => f.id === 'C12')
    expect(found).toEqual([{
      id: 'C12', level: 'error',
      message: 'system packages not installed: poppler-utils, unzip',
      fix: 'sudo apt-get install -y poppler-utils unzip',
    }])
    await expect(run(ctx)).rejects.toThrow(DeployError)
    expect(head()).toBe(OLD)
    expect(host.commands('pnpm').filter((c) => c !== 'pnpm --version')).toEqual([])
    // Probed one by one, as argv, outside the checkout; nothing installed — a deploy is never root.
    expect(probes(host).slice(0, 4).map((c) => c.args)).toEqual(PACKAGES.map((p) => ['-W', '-f=${Status}', p]))
    expect(probes(host).every((c) => c.options.cwd !== DIR)).toBe(true)
    expect(apt(host)).toEqual([])
    expect(noShell(host.calls)).toEqual([])
  })

  it('installed (held, or of two architectures, too): no finding, and the run goes on', async () => {
    const { host } = server({ env: GOOD_ENV })
    dpkg(host, new Set(PACKAGES))
    host.handlers.unshift(({ command, args }) => (command === 'dpkg-query' && args[2] === 'unzip' ? ok('hold ok installedinstall ok installed') : undefined))
    host.handlers.unshift(({ command, args }) => (command === 'dpkg-query' && args[2] === 'poppler-utils' ? ok('deinstall ok config-files') : undefined))
    expect((await preflight(context(host, config(['unzip'])))).findings.filter((f) => f.id === 'C12')).toEqual([])
    // Removed, its configuration kept: not installed.
    expect((await preflight(context(host, config(['poppler-utils'])))).findings.find((f) => f.id === 'C12')?.level).toBe('error')
  })

  it('no dpkg-query (not Debian/Ubuntu): a warning that nothing could be verified, not an error', async () => {
    const { host } = server({ env: GOOD_ENV })
    host.handlers.unshift(({ command }) => (command === 'dpkg-query' ? fail('spawn dpkg-query ENOENT', 127) : undefined))
    const found = (await preflight(context(host, config()))).findings.filter((f) => f.id === 'C12')
    expect(found).toEqual([{ id: 'C12', level: 'warning', message: `system.packages (${PACKAGES.join(', ')}) cannot be verified: no dpkg-query on this server (Debian/Ubuntu only)` }])
    expect(probes(host)).toHaveLength(1)
  })

  it('nothing declared: nothing probed', async () => {
    const { host } = server({ env: GOOD_ENV })
    await preflight(context(host, acmeConfig()))
    expect(host.calls.some((c) => c.command === 'dpkg-query')).toBe(false)
  })

  it('plan says which are installed or missing', async () => {
    const all = server({ env: GOOD_ENV }).host
    dpkg(all, new Set(PACKAGES))
    expect(await plan(context(all, config()))).toBe(0)
    expect(all.printed).toContain(`INFO system: ${PACKAGES.join(', ')} (installed)`)
    const some = server({ env: GOOD_ENV }).host
    dpkg(some, new Set(['tesseract-ocr']))
    expect(await plan(context(some, config()))).toBe(1)
    expect(some.printed).toContain(`INFO system: ${PACKAGES.join(', ')} (missing: tesseract-ocr-por, poppler-utils, unzip)`)
    expect(apt(some)).toEqual([])
  })
})

const ROOT = { uid: 0, gid: 0 }
const USER = { uid: 1000, gid: 1000 }

/** A server as root sees it (install.test.ts): a root-owned tree and the app user's checkout. */
function rootServer(): FakeHost {
  const host = new FakeHost()
  host.userId = 0
  for (const dir of ['/', '/etc', '/var', '/var/lib', '/srv', '/etc/apache2', '/etc/apache2/sites-available', '/etc/apache2/sites-enabled']) host.dir(dir, 0o755, ROOT)
  host.dir(DIR, 0o755, USER)
  return host
    .on(({ command, args }) => (command === 'id' ? ok(args[0] === '-nG' ? 'ubuntu\n' : '1000\n') : undefined))
    .on(({ command }) => (['a2enmod', 'apachectl', 'systemctl'].includes(command) ? ok() : undefined))
}

const installPlan = (over: Partial<InstallPlan> = {}): InstallPlan => ({
  kind: PLAN_KIND, version: 1, app: 'acme', domain: 'acme.example.com', tenants: 'none', dir: DIR, port: 3002,
  proxy: { kind: 'none' }, envFiles: [], docker: false, system: { packages: PACKAGES }, tool: '0.7.0', ...over,
})

describe('the install plan carries the list as data', () => {
  it('install-plan writes the names; none declared, no field', async () => {
    const host = new FakeHost().put(`${DIR}/.env`, 'PORT=3002\n', 0o600)
    expect((await buildInstallPlan(context(host, config()), '0.7.0')).system).toEqual({ packages: PACKAGES })
    expect('system' in (await buildInstallPlan(context(host, acmeConfig()), '0.7.0'))).toBe(false)
  })

  it('root validates every name again: a plan is untrusted input', () => {
    const refuse = (system: unknown) => expect(() => parseInstallPlan(JSON.stringify({ ...installPlan(), system }), 'p.json'), JSON.stringify(system)).toThrow(/p\.json is refused/)
    refuse({ packages: ['-oDpkg::Pre-Invoke::=id'] })
    refuse({ packages: ['unzip; curl x | sh'] })
    refuse({ packages: ['unzip', 'unzip'] })
    refuse({ packages: 'unzip' })
    refuse({ packages: [1] })
    refuse({ packages: Array.from({ length: 65 }, (_, i) => `pkg${i}`) })
    refuse({ packages: ['unzip'], sources: ['deb http://example.com/ ./'] })
    refuse(['unzip'])
    expect(parseInstallPlan(JSON.stringify(installPlan()), 'p.json').system).toEqual({ packages: PACKAGES })
  })
})

describe('install (root) installs the missing ones only', () => {
  it('shows them, asks, then apt-get with argv: update once, install without recommends, noninteractive', async () => {
    const host = dpkg(rootServer(), new Set(['tesseract-ocr', 'poppler-utils']))
    host.confirmations.push(true)
    expect(await install(host, installPlan(), 'ubuntu')).toBe(0)
    expect(host.transcript).toContain(`system packages ${PACKAGES.join(', ')}`)
    expect(host.prompts).toEqual(['Install tesseract-ocr-por, unzip as root?'])
    expect(host.calls.filter((c) => c.command === 'env' && c.args[1] === 'apt-get').map((c) => [c.args, c.options.cwd])).toEqual([
      [['DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update', '-qq'], '/'],
      [['DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-qq', '--no-install-recommends', 'tesseract-ocr-por', 'unzip'], '/'],
    ])
    expect(noShell(host.calls)).toEqual([])
  })

  it('all installed: nothing asked, nothing run', async () => {
    const host = dpkg(rootServer(), new Set(PACKAGES))
    expect(await install(host, installPlan(), 'ubuntu')).toBe(0)
    expect(host.prompts).toEqual([])
    expect(apt(host)).toEqual([])
    expect(host.transcript).toContain(`OK ${PACKAGES.join(', ')} installed`)
  })

  it('not confirmed (or no terminal): nothing installed, the fix printed', async () => {
    const host = dpkg(rootServer(), new Set())
    await expect(install(host, installPlan({ system: { packages: ['unzip'] } }), 'ubuntu')).rejects.toThrow('system packages not confirmed — nothing installed (a terminal must answer; or, by hand: sudo apt-get install -y unzip)')
    expect(apt(host)).toEqual([])
  })

  it('a failing apt-get stops install; no dpkg-query: said, nothing installed', async () => {
    const broken = dpkg(rootServer(), new Set())
    broken.handlers.unshift(({ command, args }) => (command === 'env' && args[2] === 'install' ? fail('E: Unable to locate package unzip', 100) : undefined))
    broken.confirmations.push(true)
    await expect(install(broken, installPlan({ system: { packages: ['unzip'] } }), 'ubuntu')).rejects.toThrow(/system packages: `env DEBIAN_FRONTEND=noninteractive apt-get install .* unzip` failed \(exit 100\)/)
    const other = rootServer().on(({ command }) => (command === 'dpkg-query' ? fail('ENOENT', 127) : undefined))
    expect(await install(other, installPlan(), 'ubuntu')).toBe(0)
    expect(other.transcript).toContain('no dpkg-query here (not Debian/Ubuntu)')
    expect(apt(other)).toEqual([])
  })

  it('a plan built in code is validated again before anything runs', async () => {
    const host = dpkg(rootServer(), new Set())
    await expect(install(host, installPlan({ system: { packages: ['--allow-unauthenticated'] } }), 'ubuntu')).rejects.toThrow(/system\.packages: "--allow-unauthenticated" is not an apt package name/)
    expect(host.calls.some((c) => c.command === 'dpkg-query' || c.command === 'env')).toBe(false)
  })
})

describe('bootstrap installs them in phase 3', () => {
  /** A server with everything bootstrap needs but the app's packages, as root (bootstrap-run.test.ts). */
  function fresh(planText: string, installed: Set<string>) {
    const host = new FakeHost()
    host.userId = 0
    for (const dir of ['/', '/etc', '/var', '/var/lib', '/srv']) host.dir(dir, 0o755, ROOT)
    host.dir(DIR, 0o755, USER).dir(`${DIR}/.git`, 0o755, USER)
    host.put(`${DIR}/package.json`, JSON.stringify({ engines: { node: '>=22.5.0' }, packageManager: 'pnpm@11.8.0' }))
    host.put('/proc/meminfo', 'MemTotal:        8008172 kB\nSwapTotal:             0 kB\n')
    host
      .on(({ command, args }) => (command === 'sh' && args[1]?.startsWith('command -v') ? (args[1].includes('apt-get') ? ok('/usr/bin/apt-get') : fail('', 1)) : undefined))
      .on(({ command, args }) => (command === 'setsid' && args.includes('install-plan') ? ok(planText) : undefined))
      .on(({ command }) => (['dpkg', 'docker', 'setsid', 'systemctl'].includes(command) ? ok() : undefined))
      .on(({ command }) => (command === 'node' ? ok('v24.1.0\n') : undefined))
      .on(({ command }) => (command === 'pnpm' ? ok('11.8.0\n') : undefined))
      .on(({ command }) => (command === 'stat' ? ok('ubuntu\n') : undefined))
      .on(({ command, args }) => (command === 'id' ? ok(args[0] === '-nG' ? 'ubuntu docker\n' : '1000\n') : undefined))
    return dpkg(host, installed)
  }

  it('a dry run shows the apt commands with a placeholder (it has no plan) and runs none', async () => {
    const host = fresh('', new Set())
    host.uid = () => 1000
    const { actions } = await planBootstrap(host, DIR, { user: 'ubuntu', dryRun: true })
    expect(actions.find((a) => a.what.startsWith('system packages'))?.commands).toEqual([
      ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update', '-qq'],
      ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-qq', '--no-install-recommends', '<system.packages>'],
    ])
    expect(await bootstrap(host, DIR, { user: 'ubuntu', dryRun: true })).toBe(0)
    expect(host.transcript).toContain('+ env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends <system.packages>')
    expect(apt(host)).toEqual([])
    expect(host.prompts).toEqual([])
  })

  it('a real run installs the missing ones after a "yes", from the plan; install then finds them all', async () => {
    const host = fresh(JSON.stringify(installPlan({ system: { packages: ['tesseract-ocr', 'unzip'] } })), new Set(['tesseract-ocr']))
    host.confirmations.push(true)
    expect(await bootstrap(host, DIR, { user: 'ubuntu', dryRun: false }, '0.7.0')).toBe(0)
    expect(host.prompts).toEqual(['Install unzip (system.packages) as root?'])
    expect(apt(host)).toEqual([
      'DEBIAN_FRONTEND=noninteractive apt-get update -qq',
      'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends unzip',
    ])
    // After the user's install-plan: the list came from the plan, as data.
    const planned = host.calls.findIndex((c) => c.command === 'setsid' && c.args.includes('install-plan'))
    expect(host.calls.findIndex((c) => c.command === 'env' && c.args.includes('unzip'))).toBeGreaterThan(planned)
    expect(host.transcript).toContain('OK tesseract-ocr, unzip installed')
    expect(noShell(host.calls)).toEqual([])
  })

  it('not confirmed: bootstrap stops with the command to run by hand', async () => {
    const host = fresh(JSON.stringify(installPlan({ system: { packages: ['unzip'] } })), new Set())
    await expect(bootstrap(host, DIR, { user: 'ubuntu', dryRun: false })).rejects.toThrow('system packages: unzip: not confirmed — nothing more was done (a terminal must answer; or install them first: sudo apt-get install -y unzip)')
    expect(apt(host)).toEqual([])
  })
})
