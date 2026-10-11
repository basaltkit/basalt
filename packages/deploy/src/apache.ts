import { join } from 'node:path'
import { vhostName, type ApacheProxy } from './config.js'
import { DeployError, INSTALL_COMMAND, type DeployContext, type Finding } from './context.js'
import { lineDiff } from './diff.js'

/**
 * The Apache target (RFC 0006 §11.3): the vhost is written ONLY by `install`,
 * as root, once. Every deploy compares what is installed with what `install`
 * would write now and prints the difference — it never rewrites a vhost in
 * production. Writing Apache configuration is root-equivalent (`CustomLog
 * "|cmd"` runs a command as root), so it is never delegated to the app user.
 */

const apacheOf = (ctx: DeployContext): ApacheProxy => {
  if (ctx.config.proxy?.kind !== 'apache') throw new Error('not an apache proxy')
  return ctx.config.proxy
}

export function vhostPaths(ctx: DeployContext) {
  const proxy = apacheOf(ctx)
  const root = proxy.root ?? '/etc/apache2'
  const file = vhostName(ctx.config) as string
  return { root, file, available: join(root, 'sites-available', file), enabled: join(root, 'sites-enabled', file) }
}

export function renderVhost(ctx: DeployContext, port: number): string {
  const proxy = apacheOf(ctx)
  const { app, domain } = ctx.config
  const alias = ctx.config.tenants === 'subdomain' ? `  ServerAlias *.${domain}\n` : ''
  const webRoot = join(ctx.dir, proxy.webRoot)
  const prefix = proxy.apiPrefix.replace(/\/$/, '')
  const cert = `/etc/letsencrypt/live/${proxy.certName ?? domain}`
  return `# Written by basalt-deploy install for "${app}". Deploys compare this file with
# what install would write and print the difference; they never rewrite it.
# To change it: edit deploy.config.ts, then sudo basalt-deploy install.

<VirtualHost *:80>
  ServerName ${domain}
${alias}  RewriteEngine On
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
</VirtualHost>

<IfModule mod_ssl.c>
<VirtualHost *:443>
  ServerName ${domain}
${alias}
  DocumentRoot ${webRoot}
  <Directory ${webRoot}>
    Require all granted
    Options -Indexes
    FallbackResource /index.html
  </Directory>

  # The API: ${prefix}/x reaches the app as /x. The Host header is kept — the
  # tenant is read from it.
  ProxyPreserveHost On
  RequestHeader set X-Forwarded-Proto "https"
  ProxyPass ${prefix}/ http://127.0.0.1:${port}/ upgrade=websocket
  ProxyPassReverse ${prefix}/ http://127.0.0.1:${port}/

  SSLEngine on
  SSLCertificateFile ${cert}/fullchain.pem
  SSLCertificateKeyFile ${cert}/privkey.pem

  ErrorLog \${APACHE_LOG_DIR}/${app}-error.log
  CustomLog \${APACHE_LOG_DIR}/${app}-access.log combined
</VirtualHost>
</IfModule>
`
}

/** The ports a vhost proxies to on this machine. */
export function proxiedPorts(vhost: string): number[] {
  return [...vhost.matchAll(/^\s*ProxyPass\s+\S+\s+(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/gim)].map((m) => Number(m[1]))
}

export async function apachePreflight(ctx: DeployContext, port: number): Promise<Finding[]> {
  const { host } = ctx
  const paths = vhostPaths(ctx)
  const findings: Finding[] = []
  const enabled = await host.stat(paths.enabled)
  const available = await host.readFile(paths.available)
  if (!enabled && available === undefined) {
    return [{ id: 'proxy', level: 'error', message: `no Apache vhost ${paths.file} yet`, fix: `${INSTALL_COMMAND} (once per server)` }]
  }
  if (!enabled) {
    findings.push({ id: 'proxy', level: 'error', message: `${paths.file} is in sites-available but not enabled`, fix: `sudo a2ensite ${paths.file} && sudo systemctl reload apache2` })
  } else if (enabled.kind === 'file') {
    // C2 — a copy in sites-enabled is what Apache loads; the file everyone
    // edits is in sites-available. The wildcard certificate went into the
    // second and was never served.
    const copy = await host.readFile(paths.enabled) ?? ''
    const same = available !== undefined && copy === available
    findings.push({
      id: 'C2',
      level: 'error',
      message: `sites-enabled/${paths.file} is a regular file, not a link to sites-available — ${same ? 'identical today, but edits to sites-available will not be served' : 'and it DIFFERS from sites-available: Apache serves the copy'}`,
      fix: `${INSTALL_COMMAND} (replaces it with a link, after showing the diff)`,
    })
  } else if (enabled.kind === 'symlink') {
    const target = await host.readlink(paths.enabled)
    if (target !== `../sites-available/${paths.file}` && target !== paths.available) {
      findings.push({ id: 'C2', level: 'error', message: `sites-enabled/${paths.file} links to ${target}, not to sites-available/${paths.file}` })
    }
  }

  const served = enabled?.kind === 'file' ? await host.readFile(paths.enabled) : available
  if (served !== undefined) {
    // C1 — the incident itself: the vhost proxied to :3000 (Apache's own
    // port on that server) while the app listened on :3002.
    for (const proxied of proxiedPorts(served)) {
      if (proxied !== port) {
        findings.push({
          id: 'C1',
          level: 'error',
          message: `the vhost proxies to 127.0.0.1:${proxied}, but the app listens on ${port}`,
          fix: `${INSTALL_COMMAND} (shows the diff and rewrites it)`,
        })
      }
    }
    const diff = lineDiff(served, renderVhost(ctx, port))
    if (diff.length > 0) {
      findings.push({
        id: 'vhost',
        level: 'warning',
        message: `the installed vhost differs from what install would write (not changed — audit only):\n${diff.map((l) => `        ${l}`).join('\n')}`,
        fix: `to apply: ${INSTALL_COMMAND}`,
      })
    }
  }
  return findings
}

/** Root only. Writes the vhost (after showing the diff and asking), links it, configtest, reload. */
export async function apacheInstall(ctx: DeployContext, port: number, backupDir: string): Promise<void> {
  const { host } = ctx
  const paths = vhostPaths(ctx)
  const wanted = renderVhost(ctx, port)
  const stamp = host.now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const restore: Array<() => Promise<void>> = []

  const current = await host.readFile(paths.available)
  if (current !== wanted) {
    if (current !== undefined) {
      host.out.info(`sites-available/${paths.file} would change:`)
      for (const line of lineDiff(current, wanted)) host.out.info(`  ${line}`)
      if (!(await host.confirm(`Write sites-available/${paths.file}?`))) throw new DeployError('vhost not changed (declined)')
      const backup = join(backupDir, `${paths.file}.available-${stamp}`)
      await host.copyFile(paths.available, backup, 0o600)
      restore.push(() => host.copyFile(backup, paths.available, 0o644))
    } else {
      restore.push(() => host.remove(paths.available))
    }
    await host.writeFile(paths.available, wanted, 0o644)
  }

  const enabled = await host.stat(paths.enabled)
  if (enabled?.kind === 'file') {
    host.out.info(`sites-enabled/${paths.file} is a copy; replacing it with a link (the copy is kept in ${backupDir})`)
    const backup = join(backupDir, `${paths.file}.enabled-copy-${stamp}`)
    await host.copyFile(paths.enabled, backup, 0o600)
    await host.remove(paths.enabled)
    restore.push(async () => { await host.remove(paths.enabled); await host.copyFile(backup, paths.enabled, 0o644) })
  }
  if ((await host.stat(paths.enabled))?.kind !== 'symlink') {
    await host.symlink(`../sites-available/${paths.file}`, paths.enabled)
    if (enabled?.kind !== 'file') restore.push(() => host.remove(paths.enabled))
  }

  const mods = await host.exec('a2enmod', ['-q', 'ssl', 'proxy', 'proxy_http', 'rewrite', 'headers'])
  if (mods.code !== 0) host.out.warn(`a2enmod: ${mods.stderr.trim()}`)

  const test = await host.exec('apachectl', ['configtest'])
  if (test.code !== 0) {
    for (const undo of restore.reverse()) await undo()
    throw new DeployError(`apachectl configtest failed — every file was put back as it was:\n${test.stderr.trim()}`)
  }
  const reload = await host.exec('systemctl', ['reload', 'apache2'])
  if (reload.code !== 0) throw new DeployError(`systemctl reload apache2 failed: ${reload.stderr.trim()}`)
  host.out.ok(`${paths.file} installed and Apache reloaded`)
}
