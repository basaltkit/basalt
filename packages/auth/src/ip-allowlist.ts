import { BlockList, isIP } from 'node:net'

/** Maximum entries in one key's `allowedIps`. */
export const API_KEY_ALLOWED_IPS_MAX = 32

/** Why an allowlist was refused; `ApiKeys` wraps it in `ApiKeyInputError`. */
export class AllowlistError extends Error {}

const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as plain IPv4; IPv6 lower-cased. Assumes a valid address. */
const canonicalAddress = (address: string): string => {
  const mapped = V4_MAPPED.exec(address)
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!
  return isIP(address) === 6 ? address.toLowerCase() : address
}

/** The 128-bit (or 32-bit) value of an address. */
function toBigInt(address: string, family: 4 | 6): bigint {
  if (family === 4) return address.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n)
  // Expand `::` and an embedded dotted-quad tail.
  let text = address
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (dotted) {
    const v4 = toBigInt(dotted[1]!, 4)
    text = `${text.slice(0, -dotted[1]!.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail !== undefined && tail !== '' ? tail.split(':') : []
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n)
}

/**
 * Validates and canonicalises one allowlist entry: an address or an
 * `address/prefix` network. Zone ids are refused, and so is a CIDR whose
 * address has host bits set (`10.0.0.5/8`) — a typo should surface, not be
 * silently masked.
 */
function canonicalEntry(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) throw new AllowlistError(`invalid entry ${JSON.stringify(raw)}`)
  if (raw.includes('%')) throw new AllowlistError(`zone ids are not allowed (${raw})`)
  const slash = raw.indexOf('/')
  const addressPart = slash === -1 ? raw : raw.slice(0, slash)
  if (isIP(addressPart) === 0) throw new AllowlistError(`not an IP address: ${raw}`)
  const address = canonicalAddress(addressPart)
  const family = isIP(address) as 4 | 6
  if (slash === -1) return address
  const prefixText = raw.slice(slash + 1)
  const bits = family === 4 ? 32 : 128
  // A mapped address keeps its IPv6 prefix length relative to 128 bits.
  const mappedShift = family === 4 && isIP(addressPart) === 6 ? 96 : 0
  if (!/^\d{1,3}$/.test(prefixText)) throw new AllowlistError(`invalid prefix length: ${raw}`)
  const rawPrefix = Number(prefixText)
  const prefix = rawPrefix - mappedShift
  if (rawPrefix > (mappedShift ? 128 : bits) || prefix < 0) throw new AllowlistError(`invalid prefix length: ${raw}`)
  const hostBits = BigInt(bits - prefix)
  if (hostBits > 0n && (toBigInt(address, family) & ((1n << hostBits) - 1n)) !== 0n) {
    throw new AllowlistError(`${raw} is not a network address (host bits are set)`)
  }
  return `${address}/${prefix}`
}

/**
 * Validates and canonicalises a key's `allowedIps`. Duplicates are dropped.
 * Throws {@link AllowlistError}.
 */
export function normalizeAllowedIps(entries: unknown): string[] {
  if (!Array.isArray(entries)) throw new AllowlistError('allowedIps must be an array')
  if (entries.length > API_KEY_ALLOWED_IPS_MAX) {
    throw new AllowlistError(`allowedIps holds at most ${API_KEY_ALLOWED_IPS_MAX} entries`)
  }
  return [...new Set(entries.map(canonicalEntry))]
}

/**
 * A request address as an adapter reports it, normalised for a check: brackets
 * and a `%zone` suffix stripped, IPv4-mapped IPv6 as IPv4. `undefined` when it
 * is not an address at all.
 */
export function normalizeRequestIp(ip: string | undefined): string | undefined {
  if (typeof ip !== 'string' || ip.length === 0) return undefined
  let text = ip.trim()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  return isIP(text) === 0 ? undefined : canonicalAddress(text)
}

/**
 * Whether `ip` is inside a (canonical) allowlist. An empty or absent list
 * allows any address; a non-empty one refuses an unknown or unparseable
 * address — it fails closed. Built per check: at most 32 entries, no cache.
 */
export function ipAllowed(allowedIps: readonly string[] | undefined, ip: string | undefined): boolean {
  if (!allowedIps || allowedIps.length === 0) return true
  const address = normalizeRequestIp(ip)
  if (address === undefined) return false
  const list = new BlockList()
  for (const entry of allowedIps) {
    const slash = entry.indexOf('/')
    if (slash === -1) {
      list.addAddress(entry, isIP(entry) === 6 ? 'ipv6' : 'ipv4')
    } else {
      const network = entry.slice(0, slash)
      list.addSubnet(network, Number(entry.slice(slash + 1)), isIP(network) === 6 ? 'ipv6' : 'ipv4')
    }
  }
  return list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}
