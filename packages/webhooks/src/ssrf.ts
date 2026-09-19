import { isIP, type LookupFunction } from 'node:net'
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

/** Parses an IPv6 literal (zone id stripped, dotted IPv4 tail allowed) into 16 bytes, or null. */
function ipv6Bytes(ip: string): number[] | null {
  let addr = (ip.split('%')[0] ?? '').toLowerCase()
  const tail: number[] = []
  const lastColon = addr.lastIndexOf(':')
  if (addr.includes('.', lastColon)) {
    const v4 = ipv4Parts(addr.slice(lastColon + 1))
    if (!v4) return null
    tail.push(...v4)
    addr = `${addr.slice(0, lastColon + 1)}0:0` // placeholder groups, replaced below
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (!head || !rest) return null
  const fill = 8 - head.length - rest.length
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest]
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff])
  if (tail.length === 4) bytes.splice(12, 4, ...tail)
  return bytes
}

const zeros = (bytes: number[], from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0)
const v4At = (bytes: number[], at: number): string => bytes.slice(at, at + 4).join('.')

/**
 * Classifies an IPv6 address over its 16 bytes, so every spelling (compressed,
 * expanded, upper-case, hex or dotted IPv4 tail — WHATWG URL canonicalises
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`) is judged the same. Forms that
 * embed an IPv4 address (mapped, translated, NAT64, 6to4) are judged by that
 * IPv4 address; transition/special-purpose ranges that can't be judged are
 * refused.
 */
function isPrivateIpv6(ip: string): boolean {
  const b = ipv6Bytes(ip)
  if (!b) return true // unparseable → treat as unsafe
  // ::/96 — unspecified (::), loopback (::1) and deprecated IPv4-compatible (::a.b.c.d).
  if (zeros(b, 0, 12)) return true
  // ::ffff:0:0/96 IPv4-mapped.
  if (zeros(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(v4At(b, 12))
  // ::ffff:0:0:0/96 IPv4-translated (SIIT).
  if (zeros(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return isPrivateIpv4(v4At(b, 12))
  // 64:ff9b::/96 well-known NAT64 prefix → the embedded IPv4 is what is reached.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(b, 4, 12)) return isPrivateIpv4(v4At(b, 12))
  // 64:ff9b:1::/48 local-use NAT64 (RFC 8215) — translator-defined, refuse.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) return true
  // 2002::/16 6to4 → the embedded IPv4 is the relay target.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(v4At(b, 2))
  // 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32, ORCHID) and 2001:db8::/32 documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2]! < 0x02 || (b[2] === 0x0d && b[3] === 0xb8))) return true
  // 100::/64 discard-only.
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(b, 2, 8)) return true
  if ((b[0]! & 0xfe) === 0xfc) return true // unique local fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true // link-local fe80::/10
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true // deprecated site-local fec0::/10
  if (b[0] === 0xff) return true // multicast ff00::/8
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
  lookup?: (host: string) => Promise<{ address: string; family?: number }[]>
}

/** A resolved-and-validated address (IP literal + its family: 4 or 6). */
export interface ValidatedAddress {
  address: string
  family: number
}

/**
 * The outcome of resolving and validating a delivery URL: the parsed URL, every
 * address it was found to resolve to (all already checked), and the single
 * address the connection MUST be pinned to. `pinned` is `null` only when
 * pinning is intentionally skipped (`allowPrivateHosts`).
 */
export interface ValidatedTarget {
  url: URL
  addresses: ValidatedAddress[]
  pinned: ValidatedAddress | null
}

const familyOf = (address: string): number => (isIP(address) === 6 ? 6 : 4)

/**
 * Resolves a delivery URL and validates it against SSRF: a disallowed scheme,
 * or a host that is — or resolves to — a private, loopback, link-local (incl.
 * `169.254.169.254`), CGNAT, ULA or reserved address is refused. Resolves the
 * hostname *once* and checks *every* returned address (so a name pointed at an
 * internal IP is caught), then returns the validated addresses and the single
 * address the caller must pin the connection to.
 *
 * Pinning closes the DNS-rebind TOCTOU: because the transport connects to
 * `pinned` (not by re-resolving the hostname), a hostile authoritative DNS that
 * returned a public IP here can't hand the socket an internal IP at connect
 * time. See `pinnedLookup` and the deliverer's transport.
 */
export async function resolveAndValidate(rawUrl: string, options: SsrfGuardOptions = {}): Promise<ValidatedTarget> {
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
  // Trusted self-hosted opt-out: skip validation *and* pinning so the operator's
  // own DNS (which may legitimately return private IPs) is honoured at connect.
  if (options.allowPrivateHosts) return { url, addresses: [], pinned: null }

  const host = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new WebhookUrlBlockedError(rawUrl, `host ${host} is a private or reserved address`)
    const literal: ValidatedAddress = { address: host, family: familyOf(host) }
    return { url, addresses: [literal], pinned: literal }
  }

  const lookup = options.lookup ?? ((h: string) => dnsLookup(h, { all: true }))
  let resolved: { address: string; family?: number }[]
  try {
    resolved = await lookup(host)
  } catch {
    throw new WebhookUrlBlockedError(rawUrl, `host "${host}" could not be resolved`)
  }
  if (resolved.length === 0) throw new WebhookUrlBlockedError(rawUrl, `host "${host}" did not resolve`)
  const addresses: ValidatedAddress[] = resolved.map((r) => ({ address: r.address, family: r.family ?? familyOf(r.address) }))
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new WebhookUrlBlockedError(rawUrl, `host "${host}" resolves to a private address (${address})`)
    }
  }
  // Every returned address is public; pin the first (IPv4 or IPv6) for connect.
  return { url, addresses, pinned: addresses[0]! }
}

/**
 * Rejects a delivery URL that could reach internal infrastructure (SSRF).
 * Thin wrapper over {@link resolveAndValidate} for callers that only need the
 * pass/fail decision and not the pinned address.
 */
export async function assertDeliverableUrl(rawUrl: string, options: SsrfGuardOptions = {}): Promise<void> {
  await resolveAndValidate(rawUrl, options)
}

/**
 * Builds a Node `lookup` function (for the http/https agent `lookup` option)
 * that ALWAYS returns the already-validated `address`, ignoring the hostname it
 * is asked to resolve. This is what pins the socket to the validated IP and
 * defeats DNS rebinding — no second, attacker-controlled resolution can happen.
 */
export function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    if (options && typeof options === 'object' && options.all) {
      callback(null, [{ address, family }])
    } else {
      // Node's callback overload: (err, address, family)
      ;(callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, address, family)
    }
  }
}
