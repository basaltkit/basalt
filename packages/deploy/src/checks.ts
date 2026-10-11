import { join } from 'node:path'
import type { DeployContext, Finding } from './context.js'

/** Whether a certificate name (`*.example.com` or exact) covers `host`. Wildcards cover one label only. */
export function covers(name: string, host: string): boolean {
  const n = name.toLowerCase()
  const h = host.toLowerCase()
  if (!n.startsWith('*.')) return n === h
  const dot = h.indexOf('.')
  return dot > 0 && h.slice(dot + 1) === n.slice(2)
}

/**
 * C8 — what a browser will see, through public DNS: the apex and, for
 * subdomain tenants, a random `x<hex>.<domain>`. A wildcard record proxied by
 * Cloudflare served the apex certificate on every tenant host; a Cloudflare
 * Origin certificate is not trusted by browsers. Warnings, not errors: the
 * deploy cannot fix a certificate, and a hotfix must not wait for one.
 */
export async function tlsFindings(ctx: DeployContext): Promise<Finding[]> {
  const { host, config } = ctx
  const hosts = [config.domain]
  if (config.tenants === 'subdomain') hosts.push(`x${host.randomHex(4)}.${config.domain}`)
  const findings: Finding[] = []
  for (const name of hosts) {
    const label = name === config.domain ? name : `a tenant host (${name})`
    const cert = await host.tlsCertificate(name)
    if ('error' in cert) {
      const dns = /ENOTFOUND|EAI_AGAIN/.test(cert.error)
      findings.push({
        id: 'C8', level: 'warning', message: `TLS to ${label}: ${cert.error}`,
        ...(name !== config.domain && dns ? { fix: `add a DNS-only (not proxied) record *.${config.domain} pointing at this server` } : {}),
        ...(/not trusted/.test(cert.error) ? { fix: 'a Cloudflare Origin certificate behind a DNS-only record? Issue a Let\'s Encrypt one (certbot --dns-cloudflare)' } : {}),
      })
      continue
    }
    if (!cert.names.some((n) => covers(n, name))) {
      findings.push({
        id: 'C8', level: 'warning', message: `the certificate served for ${label} covers only ${cert.names.join(', ') || '(no names)'}`,
        ...(name === config.domain ? {} : { fix: `issue a wildcard: certbot certonly --dns-cloudflare -d ${config.domain} -d '*.${config.domain}', and make *.${config.domain} DNS-only` }),
      })
    } else if (!cert.trusted) {
      findings.push({ id: 'C8', level: 'warning', message: `the certificate served for ${label} is not trusted by browsers (${cert.trustError ?? 'unknown reason'}) — a Cloudflare Origin certificate behind a DNS-only record?` })
    }
    const days = Math.floor((cert.validTo.getTime() - host.now().getTime()) / 86_400_000)
    if (days < 14) findings.push({ id: 'C8', level: 'warning', message: `the certificate for ${label} expires in ${days} day(s)`, fix: 'certbot renew' })
  }
  return findings
}

function minimumVersion(range: string | undefined): number[] | undefined {
  const match = range ? /(\d+)\.(\d+)(?:\.(\d+))?/.exec(range) : null
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined
}

const below = (version: number[], minimum: number[]) => {
  for (let i = 0; i < 3; i++) {
    if ((version[i] ?? 0) !== (minimum[i] ?? 0)) return (version[i] ?? 0) < (minimum[i] ?? 0)
  }
  return false
}

/** C9 — the toolchain the pipeline will call, before it calls it. */
export async function toolingFindings(ctx: DeployContext): Promise<Finding[]> {
  const { host } = ctx
  const findings: Finding[] = []
  let pkg: { engines?: { node?: string }; packageManager?: string } = {}
  try {
    pkg = JSON.parse((await host.readFile(join(ctx.dir, 'package.json'))) ?? '{}') as typeof pkg
  } catch {
    findings.push({ id: 'C9', level: 'error', message: 'package.json is not valid JSON' })
  }
  const node = await host.exec('node', ['--version'])
  const nodeVersion = minimumVersion(node.stdout)
  const nodeMinimum = minimumVersion(pkg.engines?.node)
  if (!nodeVersion) findings.push({ id: 'C9', level: 'error', message: 'node is not on PATH' })
  else if (nodeMinimum && below(nodeVersion, nodeMinimum)) {
    findings.push({ id: 'C9', level: 'error', message: `node ${node.stdout.trim()} is older than engines.node (${pkg.engines?.node})` })
  }
  const pm = await host.exec(ctx.pm, ['--version'])
  if (pm.code !== 0) {
    findings.push({ id: 'C9', level: 'error', message: `${ctx.pm} is not on PATH`, fix: 'corepack enable' })
  } else {
    const declared = pkg.packageManager?.split('@')[1]?.split('.')[0]
    const actual = pm.stdout.trim().split('.')[0]
    // Flags change between majors (pnpm 11 refuses --prod=false).
    if (declared && actual && declared !== actual) {
      findings.push({ id: 'C9', level: 'error', message: `${ctx.pm} ${pm.stdout.trim()} on this server, but package.json declares ${pkg.packageManager}`, fix: 'corepack enable (it then runs the declared version)' })
    }
  }
  if (ctx.config.infra?.kind === 'docker') {
    const docker = await host.exec('docker', ['compose', 'version'])
    if (docker.code !== 0) findings.push({ id: 'C9', level: 'error', message: 'docker compose is not available to this user' })
  }
  return findings
}
