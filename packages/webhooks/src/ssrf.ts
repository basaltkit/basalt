import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

/** Thrown when a delivery URL points somewhere we refuse to send (SSRF guard). */
export class WebhookUrlBlockedError extends Error {
  constructor(url: string, reason: string) {
    super(`Refusing to deliver webhook to ${url}: ${reason}.`)
    this.name = 'WebhookUrlBlockedError'
  }
}

function ipv4Parts(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number, number]
}

function isPrivateIpv4(ip: string): boolean {
  const p = ipv4Parts(ip)
  if (!p) return true // unparseable → treat as unsafe
  const [a, b, c] = p
  if (a === 0) return true // "this" network
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local (incl. 169.254.169.254 cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT (100.64.0.0/10)
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast (224/4) + reserved (240/4) + broadcast
  return false
}

function isPrivateIpv6(ip: string): boolean {
  const addr = (ip.split('%')[0] ?? '').toLowerCase() // strip zone id
  if (addr === '::1' || addr === '::') return true // loopback / unspecified
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped ::ffff:a.b.c.d
  if (mapped?.[1]) return isPrivateIpv4(mapped[1])
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true // unique local fc00::/7
  if (/^fe[89ab]/.test(addr)) return true // link-local fe80::/10
  if (addr.startsWith('ff')) return true // multicast ff00::/8
  return false
}

/** True for loopback, private, link-local, CGNAT, ULA and reserved ranges. */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isPrivateIpv4(ip)
  if (version === 6) return isPrivateIpv6(ip)
  return true // not an IP literal — the caller must resolve first; unknown ⇒ unsafe
}

export interface SsrfGuardOptions {
  /** Escape hatch for trusted self-hosted setups delivering to internal hosts. */
  allowPrivateHosts?: boolean
  /** Permitted URL schemes. Default `['https:', 'http:']`. */
  allowedSchemes?: string[]
  /** Injected resolver (tests). Default `dns.lookup(host, { all: true })`. */
  lookup?: (host: string) => Promise<{ address: string }[]>
}

/**
 * Rejects a delivery URL that could reach internal infrastructure (SSRF):
 * a disallowed scheme, or a host that is — or resolves to — a private,
 * loopback, link-local (incl. `169.254.169.254`), CGNAT, ULA or reserved
 * address. Resolves the hostname and checks *every* returned address so a
 * name pointed at an internal IP is caught too.
 *
 * Residual: a DNS-rebind between this check and the socket connect (TOCTOU)
 * needs the connection pinned to the validated IP — out of scope here, so
 * prefer an egress allow-list for hostile-tenant deployments.
 */
export async function assertDeliverableUrl(rawUrl: string, options: SsrfGuardOptions = {}): Promise<void> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new WebhookUrlBlockedError(rawUrl, 'not a valid absolute URL')
  }
  const schemes = options.allowedSchemes ?? ['https:', 'http:']
  if (!schemes.includes(url.protocol)) {
    throw new WebhookUrlBlockedError(rawUrl, `scheme "${url.protocol}" is not allowed`)
  }
  if (options.allowPrivateHosts) return

  const host = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new WebhookUrlBlockedError(rawUrl, `host ${host} is a private or reserved address`)
    return
  }

  const lookup = options.lookup ?? ((h: string) => dnsLookup(h, { all: true }))
  let addresses: { address: string }[]
  try {
    addresses = await lookup(host)
  } catch {
    throw new WebhookUrlBlockedError(rawUrl, `host "${host}" could not be resolved`)
  }
  if (addresses.length === 0) throw new WebhookUrlBlockedError(rawUrl, `host "${host}" did not resolve`)
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new WebhookUrlBlockedError(rawUrl, `host "${host}" resolves to a private address (${address})`)
    }
  }
}
