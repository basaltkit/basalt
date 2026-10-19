/**
 * RFC 0007 §7–§8: the Caddy target and `basalt-deploy bootstrap`.
 */
import { describe, expect, it } from 'vitest'
import { bootstrap, planBootstrap } from '../src/bootstrap.js'
import { caddyInstall, caddyPreflight, caddyProxiedPorts, renderMain, renderSite } from '../src/caddy.js'
import { caddy, DeployConfigError, validateConfig } from '../src/config.js'
import { context, DIR, FakeHost, fail, acmeConfig, ok } from './fake-host.js'

const PORT = 3002
const config = (extra = {}) => acmeConfig({ proxy: caddy({ onDemandTls: { ask: '/tls/allowed' } }), ...extra })

describe('the caddy target', () => {
  it('renders one site: apex and tenant hosts on demand, the API prefix stripped, the SPA from web/dist', () => {
    const site = renderSite(context(new FakeHost(), config()), PORT)
    expect(site).toContain('acme.example.com, *.acme.example.com {')
    expect(site).toContain('\ttls {\n\t\ton_demand\n\t}')
    expect(site).toContain('handle /api/* {\n\t\turi strip_prefix /api\n\t\treverse_proxy 127.0.0.1:3002 {')
    expect(site).toContain(`root * ${DIR}/web/dist`)
    expect(caddyProxiedPorts(site)).toEqual([3002])
    expect(renderMain(context(new FakeHost(), config()), PORT)).toContain('on_demand_tls {\n\t\task http://127.0.0.1:3002/tls/allowed\n\t}')
  })

  it('tenants on subdomains need on-demand TLS: refused without it', () => {
    expect(() => validateConfig(acmeConfig({ proxy: caddy() }))).toThrow(DeployConfigError)
    expect(validateConfig(acmeConfig({ tenants: 'none', proxy: caddy() })).proxy?.kind).toBe('caddy')
  })

  it('install on a stock Caddy: the site, the main file with the ask endpoint, validate, reload', async () => {
    const host = new FakeHost().put('/etc/caddy/Caddyfile', ':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n')
      .on(({ command }) => (command === 'caddy' || command === 'systemctl' ? ok() : undefined))
    host.confirmations.push(true)   // the stock Caddyfile is shown, then replaced
    const ctx = context(host, config())
    await caddyInstall(ctx, PORT, '/var/lib/basalt/acme/install-backups')
    expect(host.file('/etc/caddy/sites/acme.caddy')).toBe(renderSite(ctx, PORT))
    expect(host.file('/etc/caddy/Caddyfile')).toContain('import /etc/caddy/sites/*.caddy')
    expect(host.file('/etc/caddy/Caddyfile')).toContain('ask http://127.0.0.1:3002/tls/allowed')
    expect(host.commands('systemctl')).toEqual(['systemctl reload-or-restart caddy'])
    expect(await caddyPreflight(ctx, PORT)).toEqual([])
  })

  it('someone\'s own Caddyfile gets one import line and a warning about the ask endpoint; a failed validate puts everything back', async () => {
    const own = '{\n\temail ops@example.ao\n}\n\nother.example.ao {\n\trespond "hi"\n}\n'
    const host = new FakeHost().put('/etc/caddy/Caddyfile', own)
    host.confirm = async () => true
    host.on(({ command }) => (command === 'caddy' ? fail('Error: adapting config: unknown directive', 1) : undefined))
    const ctx = context(host, config())
    await expect(caddyInstall(ctx, PORT, '/b')).rejects.toThrow(/caddy validate failed — every file was put back/)
    expect(host.file('/etc/caddy/Caddyfile')).toBe(own)
    expect(host.file('/etc/caddy/sites/acme.caddy')).toBeUndefined()
    expect(host.transcript).toContain('is not the package\'s: add on_demand_tls')
  })

  it('preflight: not imported is C2, the wrong port C1, no ask C8, an edited site is audited', async () => {
    const host = new FakeHost()
    const ctx = context(host, config())
    expect((await caddyPreflight(ctx, PORT))[0]?.message).toContain('no Caddy site')
    host.put('/etc/caddy/Caddyfile', '{\n}\n').put('/etc/caddy/sites/acme.caddy', renderSite(ctx, 3000))
    const ids = (await caddyPreflight(ctx, PORT)).map((f) => f.id)
    expect(ids).toEqual(['C2', 'C8', 'C1', 'vhost'])
  })
})

describe('basalt-deploy bootstrap', () => {
  /** A fresh Ubuntu: nothing but apt, node 20, 4 GB of RAM, sshd. */
  function fresh(extra: { ufwActive?: boolean; listening?: string } = {}) {
    return new FakeHost()
      .dir(DIR, 0o755, { uid: 0, gid: 0 }).dir(`${DIR}/.git`, 0o755, { uid: 0, gid: 0 })
      .put(`${DIR}/package.json`, JSON.stringify({ engines: { node: '>=22.5.0' }, packageManager: 'pnpm@12.3.4' }))
      .put(`${DIR}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\npackageManagerDependencies:\n  pnpm:\n    specifier: 12.3.4\n")
      .put('/proc/meminfo', 'MemTotal:        4008172 kB\nSwapTotal:             0 kB\n')
      .on(({ command, args }) => (command === 'sh' && args[1]?.startsWith('command -v') ? (/apt-get|ufw/.test(args[1]) ? ok('/usr/bin/x') : fail('', 1)) : undefined))
      .on(({ command, args }) => (command === 'dpkg' ? (args[1] === 'git' ? fail('', 1) : ok()) : undefined))
      .on(({ command }) => (command === 'docker' ? fail('not found', 127) : undefined))
      .on(({ command }) => (command === 'node' ? ok('v20.11.0\n') : undefined))
      .on(({ command }) => (command === 'pnpm' ? fail('', 127) : undefined))
      .on(({ command }) => (command === 'ufw' ? ok(extra.ufwActive ? 'Status: active\n' : 'Status: inactive\n') : undefined))
      .on(({ command }) => (command === 'ss' ? ok(extra.listening ?? 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*\n') : undefined))
      .on(({ command }) => (command === 'stat' ? ok('root\n') : undefined))
      .on(({ command, args }) => (command === 'id' ? ok(args[0] === '-u' ? '1000\n' : 'ubuntu adm\n') : undefined))
  }
  const options = { user: 'ubuntu', proxy: 'caddy' as const, dryRun: true }

  it('plans only what is missing, in order, and hands over to the user', async () => {
    const { actions, notes } = await planBootstrap(fresh(), DIR, options)
    expect(actions.map((a) => a.what)).toEqual([
      'packages: git',
      'Docker + compose (download.docker.com)',
      'Node 24 (NodeSource; engines.node >=22.5.0)',
      'pnpm 12.3.4',
      `${DIR} owned by ubuntu`,
      'ubuntu in the docker group',
      'as ubuntu: dependencies',
      'as ubuntu: the .env (asks what it cannot generate)',
      'as ubuntu: the install plan (data only)',
      'system packages: those of system.packages not installed (from the install plan)',
      'swap 4 GB (3.8 GB RAM, none yet)',
      'ufw on: SSH (22), 80, 443 only',
      'Caddy (cloudsmith)',
      'install (root, from the plan): state directory, the proxy site, env ownership',
    ])
    expect(notes[0]).toContain('that is root on this machine')
    // The user's steps: argv in the checkout — no shell, no quoting of the path.
    const steps = actions.filter((a) => a.what.startsWith('as ubuntu'))
    // Never on root's terminal (TIOCSTI): each in a session of its own.
    expect(steps.map((a) => [a.cwd, a.commands.map((c) => c.join(' '))])).toEqual([
      [DIR, ['setsid -w sudo -u ubuntu -H -- env -u NODE_ENV pnpm install --frozen-lockfile']],
      [DIR, ['setsid -w sudo -u ubuntu -H -- node node_modules/@basaltkit/deploy/dist/bin.js env']],
      [DIR, ['setsid -w sudo -u ubuntu -H -- node node_modules/@basaltkit/deploy/dist/bin.js install-plan --out=-']],
    ])
    expect(steps.some((a) => a.interactive)).toBe(false)
    expect(actions.flatMap((a) => a.commands).some((c) => c[0] === 'sh' && c.join(' ').includes(DIR))).toBe(false)
  })

  it('at a terminal, env asks through a terminal of its own (script, run by root), never through root\'s', async () => {
    const host = fresh()
    host.tty = true
    const env = (await planBootstrap(host, DIR, options)).actions.find((a) => a.what.startsWith('as ubuntu: the .env'))
    expect(env?.interactive).toBe(true)
    expect(env?.commands).toEqual([['script', '--quiet', '--return', '--command', 'sudo -u ubuntu -H -- node node_modules/@basaltkit/deploy/dist/bin.js env', '/dev/null']])
  })

  it('ufw is never turned on over services it would cut off; when already on, rules are added', async () => {
    const shared = await planBootstrap(fresh({ listening: 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 511 *:3000 *:*\n' }), DIR, options)
    expect(shared.actions.some((a) => a.what.startsWith('ufw'))).toBe(false)
    expect(shared.notes).toContain('ufw is off and ports 3000 listen: not turned on, so nothing is cut off — configure it by hand')
    const active = await planBootstrap(fresh({ ufwActive: true }), DIR, { ...options, proxy: 'none' })
    expect(active.actions.find((a) => a.what.startsWith('ufw'))?.commands).toEqual([['ufw', 'allow', '22/tcp']])
  })

  it('dry run prints and runs nothing; a real run needs root and a real user, never root', async () => {
    const host = fresh()
    expect(await bootstrap(host, DIR, options)).toBe(0)
    expect(host.calls.some((c) => c.command === 'apt-get' || c.args.includes('apt-get'))).toBe(false)
    expect(host.transcript).toContain('+ npm install -g pnpm@12.3.4')
    await expect(bootstrap(fresh(), DIR, { ...options, dryRun: false })).rejects.toThrow(/run it with sudo/)
    await expect(bootstrap(fresh(), DIR, { ...options, user: 'root' })).rejects.toThrow(/never root/)
    await expect(bootstrap(fresh(), DIR, { ...options, user: "x' ; touch /tmp/p ; '" })).rejects.toThrow(/not a login name/)
  })

  it('runs every command as planned and stops at the first that fails', async () => {
    const host = fresh()
    host.uid = () => 0
    host.on(({ command, args }) => (command === 'env' && args.includes('install') && args.includes('docker-ce') ? fail('E: Unable to locate package', 100) : undefined))
    host.on(() => ok())
    await expect(bootstrap(host, DIR, { ...options, dryRun: false })).rejects.toThrow(/Docker \+ compose .* failed \(exit 100\)/)
    expect(host.transcript).toContain('OK packages: git')
  })

  it('REGRESSION: never `chown -R` of / — --dir is a checkout, not the working directory', async () => {
    // `cd / && sudo … bootstrap` without --dir used to chown -R the whole filesystem.
    const host = fresh()
    host.uid = () => 0
    host.on(() => ok())
    for (const dir of ['/', '/etc', '/home', '/srv', '/usr/local', '/var/lib/docker', '/etc/acme', '/srv/acme/../..', '/srv/acme/']) {
      await expect(bootstrap(host, dir, { ...options, dryRun: false }), dir).rejects.toThrow(/^--dir: .* refused, nothing was done/)
    }
    expect(host.commands('chown')).toEqual([])
    expect(host.calls.filter((c) => c.command !== 'id')).toEqual([])
    // Not a checkout: no package.json, no .git, or reached through a link.
    const bare = new FakeHost().dir('/srv/empty').on(({ command }) => (command === 'id' ? ok('1000') : undefined))
    await expect(bootstrap(bare, '/srv/empty', options)).rejects.toThrow('--dir: /srv/empty has no package.json')
    bare.put('/srv/empty/package.json', '{}')
    await expect(bootstrap(bare, '/srv/empty', options)).rejects.toThrow('--dir: /srv/empty has no .git')
    bare.files.set('/srv/link', { kind: 'symlink', target: '/srv/empty' })
    await expect(bootstrap(bare, '/srv/link', options)).rejects.toThrow(/a symbolic link is refused/)
  })

  it('the chown -R of a checkout the user does not own needs a yes; a dry run only shows it', async () => {
    const dry = fresh()
    expect(await bootstrap(dry, DIR, options)).toBe(0)
    expect(dry.transcript).toContain(`+ chown -R ubuntu: ${DIR}`)
    expect(dry.prompts).toEqual([])
    const host = fresh()
    host.uid = () => 0
    host.on(() => ok())
    await expect(bootstrap(host, DIR, { ...options, dryRun: false })).rejects.toThrow(`${DIR} owned by ubuntu: not confirmed`)
    expect(host.prompts).toContain(`${DIR} is root's: give it and everything in it to ubuntu (chown -R)?`)
    expect(host.commands('chown')).toEqual([])
  })

  it('reads package.json and the lockfile as data, never through a link', async () => {
    const host = fresh()
    host.files.set(`${DIR}/package.json`, { kind: 'symlink', target: '/dev/zero' })
    host.files.set(`${DIR}/pnpm-lock.yaml`, { kind: 'symlink', target: '/etc/shadow' })
    await expect(bootstrap(host, DIR, options)).rejects.toThrow('has no package.json')
    host.put(`${DIR}/package.json`, JSON.stringify({ packageManager: 'pnpm@12.3.4' }))
    expect(await bootstrap(host, DIR, options)).toBe(0)
    // The linked lockfile was not read: the version came from packageManager.
    expect(host.transcript).toContain('+ npm install -g pnpm@12.3.4')
  })

  it('the SSH port comes from SSH_CONNECTION; a hostile value is ignored, in linear time', async () => {
    const host = fresh({ listening: 'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*\n' })
    host.env = { SSH_CONNECTION: '10.0.0.5 51234 10.0.0.9 2222' }
    expect((await planBootstrap(host, DIR, options)).actions.find((a) => a.what.startsWith('ufw'))?.what).toBe('ufw on: SSH (2222), 80, 443 only')
    const hostile = fresh()
    hostile.env = { SSH_CONNECTION: '!'.repeat(100_000) }
    const started = Date.now()
    expect((await planBootstrap(hostile, DIR, options)).actions.find((a) => a.what.startsWith('ufw'))?.what).toBe('ufw on: SSH (22), 80, 443 only')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('outside apt it says so', async () => {
    const host = new FakeHost().dir(DIR).dir(`${DIR}/.git`).put(`${DIR}/package.json`, '{}').on(({ command }) => (command === 'sh' ? fail('', 1) : undefined)).on(({ command }) => (command === 'id' ? ok('1000') : undefined))
    await expect(bootstrap(host, DIR, options)).rejects.toThrow(/Ubuntu or Debian only/)
  })
})
