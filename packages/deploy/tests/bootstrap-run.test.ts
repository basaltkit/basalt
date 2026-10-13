import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrap, lockedDeployVersion } from '../src/bootstrap.js'
import { main } from '../src/cli.js'
import { PLAN_KIND, type InstallPlan } from '../src/install-plan.js'
import { DIR, FakeHost, fail, ok } from './fake-host.js'

const ROOT = { uid: 0, gid: 0 }
const plan = (over: Partial<InstallPlan> = {}): InstallPlan => ({
  kind: PLAN_KIND, version: 1, app: 'acme', domain: 'acme.example.com', tenants: 'none', dir: DIR, port: 3002,
  proxy: { kind: 'caddy', managed: true, webRoot: 'web/dist', apiPrefix: '/api' }, envFiles: [], docker: true,
  bootstrap: { swapGb: 0 }, tool: '0.5.0', ...over,
})

/** A server with everything but Caddy, as root; the user's install-plan answers `planText`. */
function server(planText: string) {
  const host = new FakeHost()
  host.userId = 0
  for (const dir of ['/', '/etc', '/var', '/var/lib', '/srv', '/etc/caddy']) host.dir(dir, 0o755, ROOT)
  host.dir(DIR, 0o755, { uid: 1000, gid: 1000 })
  host.put(`${DIR}/package.json`, JSON.stringify({ engines: { node: '>=22.5.0' }, packageManager: 'pnpm@11.8.0' }))
  host.put(`${DIR}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\npackages:\n\n  '@basaltkit/deploy@0.4.9':\n    resolution: {}\n")
  host.put('/proc/meminfo', 'MemTotal:        2008172 kB\nSwapTotal:             0 kB\n')
  return host
    .on(({ command, args }) => (command === 'sh' && args[1]?.startsWith('command -v') ? (args[1].includes('apt-get') ? ok('/usr/bin/apt-get') : fail('', 1)) : undefined))
    .on(({ command, args }) => (command === 'sudo' && args.includes('install-plan') ? ok(planText) : undefined))
    .on(({ command }) => (['dpkg', 'docker', 'sudo', 'env', 'sh', 'systemctl', 'caddy'].includes(command) ? ok() : undefined))
    .on(({ command }) => (command === 'node' ? ok('v24.1.0\n') : undefined))
    .on(({ command }) => (command === 'pnpm' ? ok('11.8.0\n') : undefined))
    .on(({ command }) => (command === 'stat' ? ok('ubuntu\n') : undefined))
    .on(({ command, args }) => (command === 'id' ? ok(args[0] === '-nG' ? 'ubuntu docker\n' : '1000\n') : undefined))
}

const options = { user: 'ubuntu', dryRun: false }

describe('bootstrap, for real', () => {
  it('system, then the user\'s steps in the checkout, then the plan decides Caddy and swap, then install in-process', async () => {
    const host = server(JSON.stringify(plan()))
    expect(await bootstrap(host, DIR, options, '0.5.0')).toBe(0)
    const sudo = host.calls.filter((c) => c.command === 'sudo')
    expect(sudo.map((c) => [c.args.slice(4).join(' '), c.options.cwd])).toEqual([
      ['env -u NODE_ENV pnpm install --frozen-lockfile', DIR],
      ['node node_modules/@basaltkit/deploy/dist/bin.js env', DIR],
      ['node node_modules/@basaltkit/deploy/dist/bin.js install-plan --out=-', DIR],
    ])
    expect(sudo[1]?.options.interactive).toBe(true)
    // Caddy comes from the plan, after it; swapGb: 0 in the plan means no swap.
    const caddyApt = host.calls.findIndex((c) => c.command === 'env' && c.args.includes('caddy'))
    expect(caddyApt).toBeGreaterThan(host.calls.indexOf(sudo[2]!))
    expect(host.calls.some((c) => c.command === 'fallocate')).toBe(false)
    // install ran in this process: no `node … install` as root, ever.
    expect(host.calls.some((c) => c.args.includes('install') && c.args.some((a) => a.includes('bin.js')) && c.command !== 'sudo')).toBe(false)
    expect(host.file('/etc/caddy/sites/acme.caddy')).toContain(`root * ${DIR}/web/dist`)
    expect(await host.stat('/var/lib/basalt/acme')).toMatchObject({ uid: 1000, mode: 0o700 })
    expect(host.transcript).toContain('this is @basaltkit/deploy 0.5.0; the lockfile records 0.4.9')
    expect(host.transcript).toContain('server ready')
  })

  it('a plan that is not valid, or names another checkout, is refused before phase 3', async () => {
    const broken = server('{"kind":"x"}')
    await expect(bootstrap(broken, DIR, options)).rejects.toThrow(/the install plan from ubuntu is refused/)
    expect(broken.calls.some((c) => c.command === 'env' && c.args.includes('caddy'))).toBe(false)
    const elsewhere = server(JSON.stringify(plan({ dir: '/srv/other' })))
    await expect(bootstrap(elsewhere, DIR, options)).rejects.toThrow('the install plan names /srv/other, not /srv/acme — refused')
    const failed = server('')
    failed.handlers.unshift(({ command, args }) => (command === 'sudo' && args.includes('install-plan') ? fail('no PORT', 1) : undefined))
    await expect(bootstrap(failed, DIR, options)).rejects.toThrow(/install-plan as ubuntu failed \(exit 1\): no PORT/)
  })

  it('reads the deploy version the lockfile records', () => {
    expect(lockedDeployVersion("  '@basaltkit/deploy@0.5.0':\n")).toBe('0.5.0')
    expect(lockedDeployVersion('  /@basaltkit/deploy@1.2.3-rc.1:\n')).toBe('1.2.3-rc.1')
    expect(lockedDeployVersion('nothing')).toBeUndefined()
  })
})

describe('the CLI bootstrap never loads deploy.config.ts', () => {
  let dir: string
  let marker: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-boot-'))
    marker = join(dir, 'config-code-ran')
    await writeFile(join(dir, 'deploy.config.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default {}\n`)
    await writeFile(join(dir, 'deploy.config.ts'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default {}\n`)
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('a dry run takes the proxy from --proxy, and --dir names the checkout', async () => {
    const host = server(JSON.stringify(plan()))
    host.userId = 1000
    expect(await main(['bootstrap', '--user=ubuntu', '--dry-run', '--proxy=caddy', `--dir=${DIR}`, '--config=deploy.config.mjs'], host, dir)).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(host.transcript).toContain('Caddy (cloudsmith)')
    expect(host.transcript).toContain('(phase 3 above assumes proxy caddy')
    expect(await main(['bootstrap', '--user=ubuntu', '--dry-run', '--proxy=nginx'], host, dir)).toBe(1)
    expect(await main(['bootstrap', '--user=ubuntu', '--dry-run', '--swap-gb=x'], host, dir)).toBe(1)
  })

  it('as root, from the checkout\'s own copy, it refuses', async () => {
    const host = server(JSON.stringify(plan()))
    expect(await main(['bootstrap', '--user=ubuntu'], host, dir)).toBe(1)
    expect(host.transcript).toContain('root would run files another user can change')
    expect(host.calls.some((c) => c.command === 'sudo')).toBe(false)
  })
})
