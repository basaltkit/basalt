import { join } from 'node:path'
import type { CaddyProxy } from './config.js'
import { DeployError, INSTALL_COMMAND, type DeployContext, type Finding } from './context.js'
import { lineDiff } from './diff.js'

/**
 * The Caddy target (RFC 0007 §8): one site file per app, imported by the main
 * Caddyfile. `install` writes it (and, on a server whose Caddyfile is still
 * the package's, the main file), validates, reloads; deploys compare and never
 * rewrite — the same contract as the Apache vhost (RFC 0006 §11.3).
 */

export const caddyOf = (ctx: DeployContext): CaddyProxy => {
  if (ctx.config.proxy?.kind !== 'caddy') throw new Error('not a caddy proxy')
  return ctx.config.proxy
}

export function caddyPaths(ctx: DeployContext) {
  const root = caddyOf(ctx).root ?? '/etc/caddy'
  return { root, main: join(root, 'Caddyfile'), dir: join(root, 'sites'), site: join(root, 'sites', `${ctx.config.app}.caddy`), importLine: `import ${join(root, 'sites')}/*.caddy` }
}

export function renderSite(ctx: DeployContext, port: number): string {
  const proxy = caddyOf(ctx)
  const { app, domain } = ctx.config
  const hosts = ctx.config.tenants === 'subdomain' ? `${domain}, *.${domain}` : domain
  const prefix = proxy.apiPrefix.replace(/\/$/, '')
  const tls = proxy.onDemandTls ? '\n\ttls {\n\t\ton_demand\n\t}\n' : ''
  return `# Written by basalt-deploy install for "${app}". Deploys compare this file with
# what install would write and print the difference; they never rewrite it.
# To change it: edit deploy.config.ts, then sudo basalt-deploy install.

${hosts} {${tls}
\tencode gzip

\t# The API: ${prefix}/x reaches the app as /x; the Host is kept — the tenant is read from it.
\thandle ${prefix}/* {
\t\turi strip_prefix ${prefix}
\t\treverse_proxy 127.0.0.1:${port} {
\t\t\tflush_interval -1
\t\t}
\t}

\thandle {
\t\troot * ${join(ctx.dir, proxy.webRoot)}
\t\ttry_files {path} /index.html
\t\tfile_server
\t}
}
${proxy.extra ? `\n${proxy.extra.trim()}\n` : ''}`
}

/** The main Caddyfile this package writes on a server that has none of its own yet. */
export function renderMain(ctx: DeployContext, port: number): string {
  const proxy = caddyOf(ctx)
  const ask = proxy.onDemandTls ? `\n\ton_demand_tls {\n\t\task http://127.0.0.1:${port}${proxy.onDemandTls.ask}\n\t}\n` : ''
  return `# Written by basalt-deploy install. Each app's site is in ${caddyPaths(ctx).dir}/.
{${ask}}

${caddyPaths(ctx).importLine}
`
}

/** The ports a site file proxies to on this machine. */
export function caddyProxiedPorts(site: string): number[] {
  return [...site.matchAll(/^\s*reverse_proxy\s+(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/gm)].map((m) => Number(m[1]))
}

/** The main Caddyfile is the one the package installs (it serves /usr/share/caddy) — safe to replace. */
const isStock = (text: string | undefined) => text === undefined || /\/usr\/share\/caddy/.test(text) && !/^\s*import\s/m.test(text)

export async function caddyPreflight(ctx: DeployContext, port: number): Promise<Finding[]> {
  const { host } = ctx
  const proxy = caddyOf(ctx)
  const paths = caddyPaths(ctx)
  const findings: Finding[] = []
  const main = await host.readFile(paths.main)
  const site = await host.readFile(paths.site)
  if (site === undefined) {
    return [{ id: 'proxy', level: 'error', message: `no Caddy site ${paths.site} yet`, fix: `${INSTALL_COMMAND} (once per server)` }]
  }
  // C2 for Caddy: a site file the main Caddyfile does not import is not served.
  if (!main?.includes(paths.importLine)) {
    findings.push({ id: 'C2', level: 'error', message: `${paths.main} does not import ${paths.dir}/*.caddy: ${paths.site} is not served`, fix: `add "${paths.importLine}" to ${paths.main}, then sudo systemctl reload caddy` })
  }
  if (proxy.onDemandTls && !main?.includes(`ask http://127.0.0.1:${port}${proxy.onDemandTls.ask}`)) {
    findings.push({
      id: 'C8',
      level: 'error',
      message: `on-demand TLS: ${paths.main} does not ask http://127.0.0.1:${port}${proxy.onDemandTls.ask} — a tenant host gets no certificate`,
      fix: `in the global block of ${paths.main}: on_demand_tls { ask http://127.0.0.1:${port}${proxy.onDemandTls.ask} }`,
    })
  }
  for (const proxied of caddyProxiedPorts(site)) {
    if (proxied !== port) {
      findings.push({ id: 'C1', level: 'error', message: `${paths.site} proxies to 127.0.0.1:${proxied}, but the app listens on ${port}`, fix: `${INSTALL_COMMAND} (shows the diff and rewrites it)` })
    }
  }
  if (proxy.managed !== false) {
    const diff = lineDiff(site, renderSite(ctx, port))
    if (diff.length > 0) {
      findings.push({
        id: 'vhost',
        level: 'warning',
        message: `the installed Caddy site differs from what install would write (not changed — audit only):\n${diff.map((l) => `        ${l}`).join('\n')}`,
        fix: `to apply: ${INSTALL_COMMAND}`,
      })
    }
  }
  return findings
}

/** Root only. Writes the site (after the diff and a yes), the main Caddyfile if it is still the stock one, validates, reloads. */
export async function caddyInstall(ctx: DeployContext, port: number, backupDir: string): Promise<void> {
  const { host } = ctx
  const paths = caddyPaths(ctx)
  const stamp = host.now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const restore: Array<() => Promise<void>> = []
  const put = async (path: string, wanted: string, label: string) => {
    const current = await host.readFile(path)
    if (current === wanted) return
    if (current !== undefined) {
      host.out.info(`${label} would change:`)
      for (const line of lineDiff(current, wanted)) host.out.info(`  ${line}`)
      if (!(await host.confirm(`Write ${path}?`))) throw new DeployError(`${label} not changed (declined)`)
      const backup = join(backupDir, `${path.split('/').pop()}-${stamp}`)
      await host.copyFile(path, backup, 0o600)
      restore.push(() => host.copyFile(backup, path, 0o644))
    } else {
      restore.push(() => host.remove(path))
    }
    await host.writeFile(path, wanted, 0o644)
  }

  await host.mkdir(paths.dir, 0o755)
  await put(paths.site, renderSite(ctx, port), paths.site)
  const main = await host.readFile(paths.main)
  if (isStock(main)) {
    await put(paths.main, renderMain(ctx, port), paths.main)
  } else if (!main?.includes(paths.importLine)) {
    // Somebody's own Caddyfile: one line added at the end, nothing else touched.
    await put(paths.main, `${main?.trimEnd() ?? ''}\n\n${paths.importLine}\n`, paths.main)
  }
  const after = await host.readFile(paths.main)
  const proxy = caddyOf(ctx)
  if (proxy.onDemandTls && !after?.includes(`ask http://127.0.0.1:${port}${proxy.onDemandTls.ask}`)) {
    host.out.warn(`${paths.main} is not the package's: add on_demand_tls { ask http://127.0.0.1:${port}${proxy.onDemandTls.ask} } to its global block, or tenant hosts get no certificate`)
  }

  const test = await host.exec('caddy', ['validate', '--adapter', 'caddyfile', '--config', paths.main])
  if (test.code !== 0) {
    for (const undo of restore.reverse()) await undo()
    throw new DeployError(`caddy validate failed — every file was put back as it was:\n${test.stderr.trim().split('\n').slice(-3).join('\n')}`)
  }
  const reload = await host.exec('systemctl', ['reload-or-restart', 'caddy'])
  if (reload.code !== 0) throw new DeployError(`systemctl reload caddy failed: ${reload.stderr.trim()}`)
  host.out.ok(`${paths.site} installed and Caddy reloaded`)
}
