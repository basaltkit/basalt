/**
 * The trust boundary of `install` (RFC 0006 §11.4): root never runs code the
 * app user can change, and never follows a path the app user can plant.
 */
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderVhost } from '../src/apache.js'
import { main, USAGE } from '../src/cli.js'
import { caddy, compose, validateConfig } from '../src/config.js'
import { INSTALL_COMMAND, RUN_COMMAND } from '../src/context.js'
import { nodeHost, type Output } from '../src/host.js'
import { buildInstallPlan, install, parseInstallPlan, PLAN_KIND, readInstallPlan, servedNames, type InstallPlan } from '../src/install-plan.js'
import { readReleases, recordRelease } from '../src/state.js'
import { untrustedToolPaths } from '../src/trust.js'
import { acmeConfig, context, DIR, FakeHost, ok } from './fake-host.js'

const ROOT = { uid: 0, gid: 0 }
const USER = { uid: 1000, gid: 1000 }

/** A server as root sees it: a root-owned tree, the app user's checkout, Apache and Caddy. */
function rootServer(): FakeHost {
  const host = new FakeHost()
  host.userId = 0
  for (const dir of ['/', '/etc', '/var', '/var/lib', '/srv', '/etc/apache2', '/etc/apache2/sites-available', '/etc/apache2/sites-enabled', '/etc/caddy']) host.dir(dir, 0o755, ROOT)
  host.dir(DIR, 0o755, USER)
  host.put('/etc/sudoers', 'root ALL=(ALL) ALL\n', 0o440, ROOT)
  return host
    .on(({ command, args }) => (command === 'id' ? ok(args[0] === '-nG' ? 'ubuntu\n' : '1000\n') : undefined))
    .on(({ command }) => (['a2enmod', 'apachectl', 'systemctl', 'caddy'].includes(command) ? ok() : undefined))
}

const plan = (over: Partial<InstallPlan> = {}): InstallPlan => ({
  kind: PLAN_KIND, version: 1, app: 'acme', domain: 'acme.example.com', tenants: 'subdomain', dir: DIR, port: 3002,
  proxy: { kind: 'apache', managed: true, vhost: `${over.app ?? 'acme'}.conf`, webRoot: 'web/dist', apiPrefix: '/api' },
  envFiles: [], docker: false, tool: '0.5.0', ...over,
})

describe('install-plan (the app user\'s half)', () => {
  it('is data: the port from the .env, the env files outside the checkout only, the proxy fields', async () => {
    const host = new FakeHost().put('/etc/acme/api.env', 'PORT=3002\n', 0o600)
    const built = await buildInstallPlan(context(host, acmeConfig({ env: { file: '/etc/acme/api.env', mirror: ['.env.worker'] } })), '0.5.0')
    expect(built).toMatchObject({ app: 'acme', dir: DIR, envFiles: ['/etc/acme/api.env'], proxy: { kind: 'apache', vhost: 'acme.conf', webRoot: 'web/dist' }, docker: false })
    expect(JSON.parse(JSON.stringify(built))).toEqual(built)
  })

  it('carries the caddy fields and the bootstrap settings, and nothing else', async () => {
    const host = new FakeHost().put(`${DIR}/.env`, 'PORT=3002\n', 0o600)
    const config = acmeConfig({ proxy: caddy({ onDemandTls: { ask: '/tls/allowed' }, extra: 'x.example.com {\n}', root: '/etc/caddy' }), bootstrap: { swapGb: 2, firewall: false } })
    const built = await buildInstallPlan(context(host, config), '0.5.0')
    expect(built.proxy).toEqual({ kind: 'caddy', managed: true, webRoot: 'web/dist', apiPrefix: '/api', onDemandTls: { ask: '/tls/allowed' }, extra: 'x.example.com {\n}', root: '/etc/caddy' })
    expect(built.bootstrap).toEqual({ swapGb: 2, firewall: false })
    expect((await buildInstallPlan(context(host, acmeConfig({ proxy: { kind: 'none' } })), '0.5.0')).proxy).toEqual({ kind: 'none' })
  })

  it('needs a PORT first (pm2); a compose app takes the upstream port', async () => {
    await expect(buildInstallPlan(context(new FakeHost()), '0.5.0')).rejects.toThrow(`run \`${RUN_COMMAND.replace(/ run$/, ' env')}\` first`)
    const config = acmeConfig({ runtime: compose({ file: 'compose.yml', images: [{ tag: 'acme', dockerfile: 'Dockerfile', env: 'ACME_IMAGE' }], upstream: { service: 'api', port: 3005 } }) })
    expect((await buildInstallPlan(context(new FakeHost(), config), '0.5.0'))).toMatchObject({ port: 3005, docker: true })
  })

  it('INSTALL_COMMAND is the user\'s half, never `sudo node node_modules/…` nor `pnpm exec`', () => {
    expect(INSTALL_COMMAND).toBe('node node_modules/@basaltkit/deploy/dist/bin.js install-plan')
    expect(USAGE).not.toMatch(/sudo "\$\(command -v node\)"/)
    expect(USAGE).toContain('sudo -H npx --yes --package=@basaltkit/deploy@<exact version> -- basalt-deploy <command>')
    expect(USAGE).not.toContain('pnpm exec basalt-deploy')
  })
})

describe('the config fields root writes into a proxy file', () => {
  it('validateConfig refuses what would escape the checkout or inject configuration', () => {
    for (const proxy of [
      { webRoot: '.' }, { webRoot: '..' }, { webRoot: '../etc' }, { webRoot: '/etc' }, { webRoot: 'web/../../etc' }, { webRoot: '.basalt' }, { webRoot: 'web/.git' }, { webRoot: 'web dist' },
      { apiPrefix: 'api' }, { apiPrefix: '/api\n  ProxyPass / http://192.0.2.7/' }, { apiPrefix: '/../x' },
      { certName: '../../etc/ssl' }, { certName: 'x y' }, { root: 'etc/apache2' }, { root: '/etc/../tmp' },
    ]) {
      expect(() => validateConfig(acmeConfig({ proxy: { kind: 'apache', webRoot: 'web/dist', apiPrefix: '/api', ...proxy } })), JSON.stringify(proxy)).toThrow(/proxy\./)
    }
    expect(() => validateConfig(acmeConfig({ tenants: 'none', proxy: caddy({ onDemandTls: { ask: '/x }\n}' as `/${string}` } }) }))).toThrow(/onDemandTls/)
  })

  it('env files live in the checkout or directly in /etc/<app>/', () => {
    for (const file of ['/etc/environment', '/etc/sudoers', '/etc/acme/../sudoers', '/etc/other/api.env', '/etc/acme/sub/api.env', '../shared/.env', '/root/.env']) {
      expect(() => validateConfig(acmeConfig({ env: { file } })), file).toThrow(/env file/)
    }
    expect(() => validateConfig(acmeConfig({ env: { file: '/etc/acme/api.env', mirror: ['config/.env'] } }))).not.toThrow()
  })

  it('parseInstallPlan re-checks every field: root trusts nothing the user wrote', () => {
    const refuse = (text: string) => expect(() => parseInstallPlan(text, 'p.json')).toThrow(/p\.json/)
    refuse('not json')
    refuse(JSON.stringify({ ...plan(), version: 2 }))
    refuse(JSON.stringify({ ...plan(), extra: 1 }))
    refuse(JSON.stringify(plan({ dir: "/srv/a'b" })))
    refuse(JSON.stringify(plan({ dir: '/' })))
    refuse(JSON.stringify(plan({ dir: '/srv/../etc' })))
    refuse(JSON.stringify(plan({ port: 0 })))
    refuse(JSON.stringify(plan({ envFiles: ['/etc/environment'] })))
    refuse(JSON.stringify(plan({ proxy: { kind: 'apache', managed: true, vhost: 'acme.conf', webRoot: '.', apiPrefix: '/api' } })))
    refuse(JSON.stringify(plan({ proxy: { kind: 'apache', managed: true, vhost: '../../cron.d/x.conf', webRoot: 'web', apiPrefix: '/api' } })))
    refuse(JSON.stringify(plan({ proxy: { kind: 'caddy', managed: true, webRoot: 'web', apiPrefix: '/api', onDemandTls: { ask: '/a', more: 1 } as never } })))
    refuse(JSON.stringify(plan({ bootstrap: { swapGb: -1 } })))
    expect(parseInstallPlan(JSON.stringify(plan()), 'p.json')).toEqual(plan())
  })
})

describe('install (root\'s half)', () => {
  it('state directory for the user, its own backups, the overrides, the vhost — and nothing read from the checkout', async () => {
    const host = rootServer()
    expect(await install(host, plan(), 'ubuntu')).toBe(0)
    expect(await host.stat('/var/lib/basalt/acme')).toMatchObject({ kind: 'dir', uid: 1000, mode: 0o700 })
    expect(await host.stat('/var/lib/basalt/acme.install-backups')).toMatchObject({ kind: 'dir', uid: 0, mode: 0o700 })
    expect(host.file('/etc/basalt/acme.json')).toBe('{}\n')
    expect(await host.readlink('/etc/apache2/sites-enabled/acme.conf')).toBe('../sites-available/acme.conf')
    expect(host.files.has('/var/lib/basalt/acme/deploy.lock')).toBe(false)
    expect(host.commands('chown')).toEqual([])
    expect(host.transcript).toContain(`installed — from now on, as ubuntu (not root), in ${DIR}: ${RUN_COMMAND}`)
  })

  it('refuses without root, without a user, as root, with a name that is not a login', async () => {
    const host = rootServer()
    host.userId = 1000
    await expect(install(host, plan(), 'ubuntu')).rejects.toThrow(/needs root/)
    host.userId = 0
    await expect(install(host, plan(), undefined)).rejects.toThrow(/--user/)
    await expect(install(host, plan(), 'root')).rejects.toThrow(/never root/)
    await expect(install(host, plan(), '-oProxy')).rejects.toThrow(/not a login name/)
  })

  it('EXPLOIT: an env file linked to /etc/sudoers is refused, never chowned', async () => {
    const host = rootServer()
    host.dir('/etc/acme', 0o700, USER)
    host.files.set('/etc/acme/api.env', { kind: 'symlink', target: '/etc/sudoers' })
    await expect(install(host, plan({ envFiles: ['/etc/acme/api.env'] }), 'ubuntu')).rejects.toThrow(/\/etc\/acme\/api\.env is a symbolic link — refused, never followed/)
    expect(await host.stat('/etc/sudoers')).toMatchObject({ uid: 0, mode: 0o440 })
    expect(host.files.has('/var/lib/basalt/acme/deploy.lock')).toBe(false)
  })

  it('a hard-linked env file and a symlinked /etc/<app> are refused too', async () => {
    const linked = rootServer()
    linked.dir('/etc/acme', 0o700, USER).put('/etc/acme/api.env', 'A=1\n', 0o600, USER)
    linked.hardLinked.add('/etc/acme/api.env')
    await expect(install(linked, plan({ envFiles: ['/etc/acme/api.env'] }), 'ubuntu')).rejects.toThrow(/hard links/)
    const dir = rootServer()
    dir.files.set('/etc/acme', { kind: 'symlink', target: '/etc' })
    await expect(install(dir, plan({ envFiles: ['/etc/acme/api.env'] }), 'ubuntu')).rejects.toThrow(/\/etc\/acme is a symbolic link/)
  })

  it('takes over /etc/<app> and its env files, 0700/0600, creating the directory when missing', async () => {
    const host = rootServer()
    host.put('/etc/acme/api.env', 'A=1\n', 0o644, ROOT)
    host.dir('/etc/acme', 0o755, ROOT)
    // A directory root made by hand: shown, and given only after a yes.
    await expect(install(host, plan({ envFiles: ['/etc/acme/api.env'] }), 'ubuntu')).rejects.toThrow(/\/etc\/acme not handed over \(not confirmed\)/)
    expect(await host.stat('/etc/acme')).toMatchObject({ uid: 0, mode: 0o755 })
    expect(host.transcript).toContain('/etc/acme exists and is root\'s (api.env): install would give it and the env files to ubuntu')
    host.confirmations.push(true)
    expect(await install(host, plan({ envFiles: ['/etc/acme/api.env', '/etc/acme/worker.env'] }), 'ubuntu')).toBe(0)
    expect(await host.stat('/etc/acme')).toMatchObject({ uid: 1000, mode: 0o700 })
    expect(await host.stat('/etc/acme/api.env')).toMatchObject({ uid: 1000, mode: 0o600 })
    expect(host.transcript).toContain('/etc/acme/worker.env does not exist yet')
    const fresh = rootServer()
    expect(await install(fresh, plan({ envFiles: ['/etc/acme/api.env'] }), 'ubuntu')).toBe(0)
    expect(await fresh.stat('/etc/acme')).toMatchObject({ kind: 'dir', uid: 1000, mode: 0o700 })
  })

  it('EXPLOIT: an app named after a system directory never gets /etc/<that> (systemd, ssh, apt, basalt…)', async () => {
    for (const app of ['systemd', 'ssh', 'apt', 'docker', 'apache2', 'caddy', 'security', 'netplan', 'basalt']) {
      expect(() => parseInstallPlan(JSON.stringify(plan({ app, envFiles: [`/etc/${app}/system.conf`] })), 'p.json'), app).toThrow(/is a system directory/)
      expect(() => validateConfig(acmeConfig({ app, env: { file: `/etc/${app}/api.env` }, runtime: { kind: 'pm2', script: 'start', port: 'auto', avoid: [] } })), app).toThrow(/is a system directory/)
    }
    // The probe itself, a plan built in code (no parse first): nothing changes hands.
    const host = rootServer().dir('/etc/systemd', 0o755, ROOT).put('/etc/systemd/system.conf', '[Manager]\n', 0o644, ROOT)
    await expect(install(host, plan({ app: 'systemd', envFiles: ['/etc/systemd/system.conf'] }), 'ubuntu')).rejects.toThrow(/system directory/)
    expect(await host.stat('/etc/systemd')).toMatchObject({ uid: 0, mode: 0o755 })
    expect(await host.stat('/etc/systemd/system.conf')).toMatchObject({ uid: 0, mode: 0o644 })
    expect(host.prompts).toEqual([])
    // A name not on the list: a directory a Debian package ships is refused too; one with subdirectories also.
    const shipped = rootServer().dir('/etc/fwupd', 0o755, ROOT).put('/etc/fwupd/fwupd.conf', 'x', 0o644, ROOT)
    shipped.handlers.unshift(({ command, args }) => (command === 'dpkg-query' && args[1] === '/etc/fwupd' ? ok('fwupd: /etc/fwupd\n') : undefined))
    await expect(install(shipped, plan({ app: 'fwupd', envFiles: ['/etc/fwupd/fwupd.conf'] }), 'ubuntu')).rejects.toThrow(/\/etc\/fwupd belongs to an installed package/)
    expect(await shipped.stat('/etc/fwupd')).toMatchObject({ uid: 0 })
    const tree = rootServer().dir('/etc/acme', 0o755, ROOT).dir('/etc/acme/conf.d', 0o755, ROOT)
    tree.confirmations.push(true)
    await expect(install(tree, plan({ envFiles: ['/etc/acme/api.env'] }), 'ubuntu')).rejects.toThrow(/\/etc\/acme holds conf\.d \(not plain files\)/)
    expect(await tree.stat('/etc/acme')).toMatchObject({ uid: 0 })
  })

  it('EXPLOIT: another app\'s state directory and env files are never handed over', async () => {
    const OTHER = { uid: 1001, gid: 1001 }
    const host = rootServer()
    host.dir('/var/lib/basalt', 0o755, ROOT).dir('/var/lib/basalt/billing', 0o700, OTHER).put('/var/lib/basalt/billing/backups/x.dump', 'db', 0o600, OTHER)
    host.dir('/etc/billing', 0o700, OTHER).put('/etc/billing/api.env', 'SECRET=1\n', 0o600, OTHER)
    await expect(install(host, plan({ app: 'billing', envFiles: ['/etc/billing/api.env'] }), 'ubuntu')).rejects.toThrow('refused: the state directory /var/lib/basalt/billing belongs to uid 1001, not ubuntu')
    expect(await host.stat('/var/lib/basalt/billing')).toMatchObject({ uid: 1001 })
    // Its state directory was never made: the env directory is checked on its own too.
    const env = rootServer()
    env.dir('/etc/billing', 0o700, OTHER).put('/etc/billing/api.env', 'SECRET=1\n', 0o600, OTHER)
    await expect(install(env, plan({ app: 'billing', envFiles: ['/etc/billing/api.env'] }), 'ubuntu')).rejects.toThrow('refused: the env directory /etc/billing belongs to uid 1001')
    expect(await env.stat('/etc/billing/api.env')).toMatchObject({ uid: 1001, mode: 0o600 })
    // A file in the user's own directory that another account owns: refused as well.
    const file = rootServer()
    file.dir('/etc/acme', 0o700, USER).put('/etc/acme/api.env', 'A=1\n', 0o600, OTHER)
    await expect(install(file, plan({ envFiles: ['/etc/acme/api.env'] }), 'ubuntu')).rejects.toThrow('refused: the env file /etc/acme/api.env belongs to uid 1001')
    // Re-running install for the user's own directories is quiet.
    const again = rootServer()
    again.dir('/etc/acme', 0o700, USER).put('/etc/acme/api.env', 'A=1\n', 0o600, USER)
    expect(await install(again, plan({ envFiles: ['/etc/acme/api.env'] }), 'ubuntu')).toBe(0)
    expect(again.prompts).toEqual([])
  })

  it('serves the app user\'s own checkout only', async () => {
    const other = rootServer().dir(DIR, 0o755, ROOT)
    await expect(install(other, plan(), 'ubuntu')).rejects.toThrow(`${DIR} is not ubuntu's (uid 0)`)
    const linked = rootServer()
    linked.files.set(DIR, { kind: 'symlink', target: '/etc' })
    await expect(install(linked, plan(), 'ubuntu')).rejects.toThrow(/not a directory \(a symbolic link is refused\)/)
  })

  it('never writes under a directory another user can change', async () => {
    const host = rootServer().dir('/var/lib/basalt', 0o755, USER)
    await expect(install(host, plan(), 'ubuntu')).rejects.toThrow(/\/var\/lib\/basalt is not a directory only root can write/)
    const apache = rootServer().dir('/etc/apache2/sites-available', 0o775, { uid: 0, gid: 1000 })
    await expect(install(apache, plan(), 'ubuntu')).rejects.toThrow(/sites-available is not a directory only root can write/)
    expect(apache.files.has('/etc/apache2/sites-available/acme.conf')).toBe(false)
  })

  it('raw Caddy `extra` and a non-default config root need a yes at the terminal; nothing is written without it', async () => {
    const extra = 'admin.acme.example.com {\n\treverse_proxy 127.0.0.1:9000\n}'
    const caddyPlan = plan({ tenants: 'none', proxy: { kind: 'caddy', managed: true, webRoot: 'web/dist', apiPrefix: '/api', extra } })
    const refused = rootServer()
    await expect(install(refused, caddyPlan, 'ubuntu')).rejects.toThrow(/proxy.extra not confirmed/)
    expect(refused.transcript).toContain('  + →   reverse_proxy 127.0.0.1:9000')
    expect(refused.files.has('/etc/caddy/sites/acme.caddy')).toBe(false)
    const accepted = rootServer()
    accepted.confirmations.push(true)
    expect(await install(accepted, caddyPlan, 'ubuntu')).toBe(0)
    expect(accepted.file('/etc/caddy/sites/acme.caddy')).toContain('reverse_proxy 127.0.0.1:9000')

    const elsewhere = rootServer().dir('/opt', 0o755, ROOT).dir('/opt/apache', 0o755, ROOT)
    await expect(install(elsewhere, plan({ proxy: { kind: 'apache', managed: true, vhost: 'acme.conf', webRoot: 'web/dist', apiPrefix: '/api', root: '/opt/apache' } }), 'ubuntu')).rejects.toThrow(/proxy root \/opt\/apache not confirmed/)
  })

  it('EXPLOIT: Caddy `extra` cannot hide text from the confirmation, nor import a file', () => {
    const caddyPlan = (extra: string) => JSON.stringify(plan({ tenants: 'none', proxy: { kind: 'caddy', managed: true, webRoot: 'web/dist', apiPrefix: '/api', extra } }))
    // The probe: a CR makes the terminal show only the comment; Caddy loads the directive.
    for (const extra of ['\treverse_proxy 192.0.2.7:80 \r\t# health endpoint, harmless', 'x {\n\x1b[2K\x1b[1A}', 'a\u202eb', 'a\u009bb', 'a\u2028b']) {
      expect(() => parseInstallPlan(caddyPlan(extra), 'p.json'), JSON.stringify(extra)).toThrow(/proxy\.extra holds a control or direction character/)
      expect(() => validateConfig(acmeConfig({ tenants: 'none', proxy: caddy({ extra }) })), JSON.stringify(extra)).toThrow(/proxy\.extra holds a control/)
    }
    for (const extra of ['import /srv/acme/site.caddy', 'x.example.com {\n\timport /srv/acme/*.caddy\n}']) {
      expect(() => parseInstallPlan(caddyPlan(extra), 'p.json'), extra).toThrow(/proxy\.extra may not `import`/)
    }
    expect(parseInstallPlan(caddyPlan('admin.acme.example.com {\n\treverse_proxy 127.0.0.1:9000 # importer\n}'), 'p.json').proxy).toMatchObject({ kind: 'caddy' })
  })

  it('EXPLOIT: a plan cannot take a co-hosted site\'s domain or sort its vhost ahead of it', async () => {
    // The vhost is the app's own file name.
    for (const vhost of ['000-aaa.conf', 'other.conf', 'acmex.conf']) {
      expect(() => parseInstallPlan(JSON.stringify(plan({ proxy: { kind: 'apache', managed: true, vhost, webRoot: 'web', apiPrefix: '/api' } })), 'p.json'), vhost).toThrow(/proxy\.vhost must be acme\.conf or start with "acme-"/)
      expect(() => validateConfig(acmeConfig({ proxy: { kind: 'apache', vhost, webRoot: 'web/dist', apiPrefix: '/api' } })), vhost).toThrow(/proxy\.vhost/)
    }
    expect(() => parseInstallPlan(JSON.stringify(plan({ proxy: { kind: 'apache', managed: true, vhost: 'acme-le-ssl.conf', webRoot: 'web', apiPrefix: '/api' } })), 'p.json')).not.toThrow()
    // Another site already serves the domain, or a wildcard over it, or a name under ours.
    const other = (text: string) => {
      const host = rootServer()
      host.put('/etc/apache2/sites-available/shop.conf', text, 0o644, ROOT)
      return host
    }
    for (const [text, taken] of [
      ['<VirtualHost *:443>\n  ServerName acme.example.com:443\n</VirtualHost>', 'acme.example.com'],
      ['<VirtualHost *:443>\n  ServerName example.com\n  ServerAlias *.example.com\n</VirtualHost>', '*.example.com'],
      ['<VirtualHost *:443>\n  ServerName shop.acme.example.com\n</VirtualHost>', 'shop.acme.example.com'],
    ] as const) {
      const host = other(text)
      await expect(install(host, plan(), 'ubuntu'), text).rejects.toThrow(`refused: /etc/apache2/sites-available/shop.conf already serves ${taken}`)
      expect(host.files.has('/etc/apache2/sites-available/acme.conf')).toBe(false)
    }
    // Unrelated sites, and our own file, are fine; the summary says what root is about to do.
    const fine = other('<VirtualHost *:443>\n  ServerName shop.example.org\n</VirtualHost>')
    fine.put('/etc/apache2/sites-available/acme.conf', 'ServerName acme.example.com\n', 0o644, ROOT)
    fine.confirmations.push(true)
    expect(await install(fine, plan(), 'ubuntu')).toBe(0)
    expect(fine.transcript).toContain(`install for "acme" (plan by @basaltkit/deploy 0.5.0), for ubuntu, checkout ${DIR}:`)
    expect(fine.transcript).toContain('Apache /etc/apache2/sites-available/acme.conf for acme.example.com, *.acme.example.com → 127.0.0.1:3002')
    // Caddy: a site address of another app.
    const caddyHost = rootServer().dir('/etc/caddy/sites', 0o755, ROOT).put('/etc/caddy/sites/shop.caddy', 'https://acme.example.com, www.example.org {\n\tfile_server\n}\n', 0o644, ROOT)
    await expect(install(caddyHost, plan({ tenants: 'none', proxy: { kind: 'caddy', managed: true, webRoot: 'web', apiPrefix: '/api' } }), 'ubuntu')).rejects.toThrow('refused: /etc/caddy/sites/shop.caddy already serves acme.example.com')
  })

  it('servedNames reads Apache names and Caddy site addresses, not directives', () => {
    expect(servedNames('<VirtualHost *:80>\n ServerName A.example.com\n ServerAlias b.example.com *.c.example.com\n</VirtualHost>', 'apache')).toEqual(['a.example.com', 'b.example.com', '*.c.example.com'])
    expect(servedNames('{\n\temail x@example.com\n}\n(snip) {\n}\n:8080 {\n}\nx.example.com:443, *.y.example.com { # c\n\thandle {\n\t\tfile_server\n\t}\n}\n', 'caddy')).toEqual(['x.example.com', '*.y.example.com'])
  })

  it('the vhost follows no link the app user plants out of its own files, and reads no .htaccess', () => {
    const vhost = renderVhost(context(new FakeHost()), 3002)
    expect(vhost).toContain(`<Directory ${DIR}>\n    Options -Indexes -FollowSymLinks +SymLinksIfOwnerMatch\n    AllowOverride None\n  </Directory>`)
    expect(vhost).toContain(`<Directory ${DIR}/web/dist>\n    Require all granted\n    Options -Indexes -FollowSymLinks +SymLinksIfOwnerMatch\n    AllowOverride None`)
    expect(vhost).toContain('# To change it: edit deploy.config.ts, run node node_modules/@basaltkit/deploy/dist/bin.js install-plan')
    expect(vhost).not.toContain('sudo basalt-deploy install')
  })

  it('renders only validated fields into the vhost', async () => {
    const host = rootServer()
    await install(host, plan({ proxy: { kind: 'apache', managed: true, vhost: 'acme.conf', webRoot: 'web/dist', apiPrefix: '/api', certName: 'acme.example.com-0001' } }), 'ubuntu')
    const vhost = host.file('/etc/apache2/sites-available/acme.conf') ?? ''
    expect(vhost).toContain(`DocumentRoot ${DIR}/web/dist`)
    expect(vhost).toContain('SSLCertificateFile /etc/letsencrypt/live/acme.example.com-0001/fullchain.pem')
    expect(vhost).toBe(renderVhost(context(host, acmeConfig({ proxy: { kind: 'apache', webRoot: 'web/dist', apiPrefix: '/api', certName: 'acme.example.com-0001' } })), 3002))
  })

  it('says what the docker group means', async () => {
    const host = rootServer()
    host.handlers.unshift(({ command, args }) => (command === 'id' && args[0] === '-nG' ? ok('ubuntu docker\n') : undefined))
    expect(await install(host, plan({ docker: true }), 'ubuntu')).toBe(0)
    expect(host.transcript).toMatch(/ubuntu is in the docker group: that is root on this machine/)
  })
})

describe('the release history moves to the state directory as the app user', () => {
  it('reads the checkout\'s history until the first record writes the new one', async () => {
    const host = new FakeHost().put(`${DIR}/.basalt/releases.json`, JSON.stringify([{ sha: 'a', status: 'ok', migrations: [], at: '', user: '' }]))
    const ctx = { ...context(host), stateDir: '/var/lib/basalt/acme' }
    expect((await readReleases(ctx)).map((r) => r.sha)).toEqual(['a'])
    await recordRelease(ctx, { sha: 'b', status: 'ok', migrations: [], at: '', user: '' })
    expect(JSON.parse(host.file('/var/lib/basalt/acme/releases.json') ?? '[]').map((r: { sha: string }) => r.sha)).toEqual(['a', 'b'])
  })
})

describe('the CLI: install-plan, install, and the tool root runs', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-install-'))
    await writeFile(join(dir, 'deploy.config.mjs'), `export default { app: 'acme', domain: 'acme.example.com', env: {}, runtime: { kind: 'pm2', script: 'start', port: 'auto', avoid: [] }, proxy: { kind: 'apache', webRoot: 'web/dist', apiPrefix: '/api' } }\n`)
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  /** Marks `path` and every directory above it root's (what a root-owned copy of the tool looks like). */
  const trust = (host: FakeHost, path: string, kind: 'file' | 'dir') => {
    if (kind === 'file') host.put(path, '', 0o755, ROOT)
    else host.dir(path, 0o755, ROOT)
    for (let d = dirname(path); ; d = dirname(d)) {
      host.dir(d, 0o755, ROOT)
      if (d === '/') break
    }
  }
  const toolDir = dirname(fileURLToPath(new URL('../src/cli.ts', import.meta.url)))

  it('install-plan writes the plan 0600 and prints the pinned root command', async () => {
    const host = new FakeHost().put(join(dir, '.env'), 'PORT=3002\n', 0o600)
    host.env['USER'] = 'ubuntu'
    expect(await main(['install-plan', '--config=deploy.config.mjs'], host, dir)).toBe(0)
    const path = join(dir, '.basalt', 'install-plan.json')
    expect(host.mode(path)).toBe(0o600)
    expect(parseInstallPlan(host.file(path) ?? '', path)).toMatchObject({ app: 'acme', dir, port: 3002 })
    expect(host.transcript).toMatch(new RegExp(`cd / && sudo -H npx --yes --package=@basaltkit/deploy@\\d+\\.\\d+\\.\\d+ -- basalt-deploy install --plan=${path} --user=ubuntu`))
  })

  it('install-plan --out=- prints the JSON only', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const host = new FakeHost().put(join(dir, '.env'), 'PORT=3002\n', 0o600)
      expect(await main(['install-plan', '--config=deploy.config.mjs', '--out=-'], host, dir)).toBe(0)
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ kind: PLAN_KIND, app: 'acme' })
    } finally {
      write.mockRestore()
    }
  })

  it('install without --plan says how; it never loads deploy.config.ts', async () => {
    const host = new FakeHost()
    expect(await main(['install', '--user=ubuntu', '--config=deploy.config.mjs'], host, dir)).toBe(1)
    expect(host.transcript).toContain(`install reads a plan, never deploy.config.ts: as the app user, in the checkout, run \`${INSTALL_COMMAND}\``)
  })

  it('as root, refuses to run from files another user can change (the checkout\'s node_modules)', async () => {
    const host = rootServer()
    host.put('/tmp/plan.json', JSON.stringify(plan()), 0o600, USER)
    expect(await main(['install', '--plan=/tmp/plan.json', '--user=ubuntu'], host, '/')).toBe(1)
    expect(host.transcript).toContain('root would run files another user can change')
    expect(host.files.has('/var/lib/basalt/acme')).toBe(false)
  })

  it('as root, from a root-owned tool, installs from the plan; a linked plan file is refused', async () => {
    const host = rootServer()
    trust(host, process.execPath, 'file')
    trust(host, toolDir, 'dir')
    host.put('/tmp/plan.json', JSON.stringify(plan()), 0o600, USER)
    expect(await main(['install', '--plan=/tmp/plan.json', '--user=ubuntu'], host, '/')).toBe(0)
    expect(host.file('/etc/apache2/sites-available/acme.conf')).toContain('ServerName acme.example.com')

    host.files.set('/tmp/linked.json', { kind: 'symlink', target: '/etc/sudoers' })
    expect(await main(['install', '--plan=/tmp/linked.json', '--user=ubuntu'], host, '/')).toBe(1)
    expect(host.transcript).toContain('--plan=/tmp/linked.json: /tmp/linked.json is a symbolic link')
    expect(await main(['install', '--plan=relative.json', '--user=ubuntu'], host, '/')).toBe(1)
  })

  it('--unsafe-tool proceeds, loudly', async () => {
    const host = rootServer()
    host.put('/tmp/plan.json', JSON.stringify(plan()), 0o600, USER)
    expect(await main(['install', '--plan=/tmp/plan.json', '--user=ubuntu', '--unsafe-tool'], host, '/')).toBe(0)
    expect(host.transcript).toContain('WARN --unsafe-tool: root would run files another user can change')
  })
})

describe('on the real filesystem', () => {
  const quiet: Output = { step() {}, info() {}, ok() {}, warn() {}, error() {} }
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-trust-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('readPlainFile never follows a link; secureOwner refuses links and hard links', async () => {
    const host = nodeHost(quiet)
    const target = join(dir, 'target')
    await writeFile(target, 'secret\n')
    await symlink(target, join(dir, 'link'))
    await expect(host.readPlainFile(join(dir, 'link'), 1024)).rejects.toThrow(/symbolic link — refused, never followed/)
    await expect(host.readPlainFile(target, 3)).rejects.toThrow(/larger than 3 bytes/)
    expect(await host.readPlainFile(target, 1024)).toBe('secret\n')

    const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }
    await expect(host.secureOwner(join(dir, 'link'), { ...me, mode: 0o600, kind: 'file' })).rejects.toThrow(/symbolic link/)
    expect((await stat(target)).mode & 0o777).not.toBe(0o600)
    await link(target, join(dir, 'hard'))
    await expect(host.secureOwner(target, { ...me, mode: 0o600, kind: 'file' })).rejects.toThrow(/2 hard links/)
    await rm(join(dir, 'hard'))
    await host.secureOwner(target, { ...me, mode: 0o600, kind: 'file' })
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    await expect(host.secureOwner(target, { ...me, mode: 0o700, kind: 'dir' })).rejects.toThrow(/not a directory/)
    expect(await readFile(target, 'utf8')).toBe('secret\n')
  })

  it('a tool under a user-owned directory is untrusted', async () => {
    const host = nodeHost(quiet)
    const file = join(dir, 'bin.js')
    await writeFile(file, '')
    const problems = await untrustedToolPaths(host, [file, join(dir, 'missing.js')])
    expect(problems).toHaveLength(2)
    expect(problems[1]).toContain('(not found)')
  })
})
