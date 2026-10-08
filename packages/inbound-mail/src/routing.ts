/** What a route matched on: the recipient split up, and the `{param}` captures. */
export interface InboundRouteMatch {
  /** The full recipient, lower-cased, `+tag` included. */
  address: string
  /** The local part without the `+tag`. */
  local: string
  /** The subaddress after the first `+`, when there is one. Sender-chosen: treat it as untrusted text. */
  tag?: string
  domain: string
  /** The `{param}` captures (each `[a-z0-9_-]{1,63}`), or what a predicate returned. */
  params: Record<string, string>
}

/**
 * An address pattern: an exact address, an address with `{param}`
 * placeholders in the local part or the domain (`'{tenant}@in.example.com'`),
 * or a predicate that returns the params or `false`.
 */
export type InboundAddressPattern = string | ((address: string) => Record<string, string> | false)

/** What a capture may contain. Anything else is a non-match, so the mail counts as unrouted. */
const CAPTURE = '([a-z0-9_-]{1,63})'

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Splits a recipient into its parts, or `undefined` when it is not `local@domain`. */
export function splitAddress(address: string): Omit<InboundRouteMatch, 'params'> | undefined {
  const lower = address.trim().toLowerCase()
  const at = lower.lastIndexOf('@')
  if (at <= 0 || at === lower.length - 1) return undefined
  const fullLocal = lower.slice(0, at)
  const domain = lower.slice(at + 1)
  const plus = fullLocal.indexOf('+')
  if (plus < 0) return { address: lower, local: fullLocal, domain }
  return { address: lower, local: fullLocal.slice(0, plus), tag: fullLocal.slice(plus + 1), domain }
}

/**
 * Compiles a pattern into a matcher. Throws a `TypeError` at construction on a
 * pattern that could never match (no `@`, a `+` in it, a malformed or repeated
 * placeholder), so a typo fails at boot rather than silently dropping mail.
 */
export function compileAddressPattern(
  pattern: InboundAddressPattern,
): (address: string) => InboundRouteMatch | undefined {
  if (typeof pattern === 'function') {
    return (address) => {
      const parts = splitAddress(address)
      if (!parts) return undefined
      const params = pattern(parts.address)
      return params === false ? undefined : { ...parts, params: { ...params } }
    }
  }
  if (typeof pattern !== 'string') throw new TypeError('inboundMailRoutes(): an address must be a string or a function.')
  const lower = pattern.trim().toLowerCase()
  const at = lower.lastIndexOf('@')
  if (at <= 0 || at === lower.length - 1) {
    throw new TypeError(`inboundMailRoutes(): "${pattern}" is not an address pattern (local@domain).`)
  }
  if (lower.slice(0, at).includes('+')) {
    throw new TypeError(
      `inboundMailRoutes(): "${pattern}" contains "+". The +tag is split off before matching and is available as match.tag.`,
    )
  }
  const names: string[] = []
  let source = ''
  // Walk the original (case-preserving) text: literals are case-folded, names are not.
  let rest = pattern.trim()
  while (rest !== '') {
    const open = rest.indexOf('{')
    const literal = open < 0 ? rest : rest.slice(0, open)
    if (literal.includes('}')) throw new TypeError(`inboundMailRoutes(): "${pattern}" has an unmatched "}".`)
    source += escapeRegExp(literal.toLowerCase())
    if (open < 0) break
    const close = rest.indexOf('}', open)
    const name = close < 0 ? '' : rest.slice(open + 1, close)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`inboundMailRoutes(): "${pattern}" has an invalid {param} placeholder.`)
    }
    if (names.includes(name)) throw new TypeError(`inboundMailRoutes(): "${pattern}" repeats {${name}}.`)
    names.push(name)
    source += CAPTURE
    rest = rest.slice(close + 1)
  }
  const regex = new RegExp(`^${source}$`)
  return (address) => {
    const parts = splitAddress(address)
    if (!parts) return undefined
    const found = regex.exec(`${parts.local}@${parts.domain}`)
    if (!found) return undefined
    const params: Record<string, string> = {}
    names.forEach((name, index) => {
      params[name] = found[index + 1]!
    })
    return { ...parts, params }
  }
}
