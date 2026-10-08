/**
 * Reading `Authentication-Results` (RFC 8601) and ARC (RFC 8617) from headers
 * that a TRUSTED server wrote, and from no others.
 *
 * Ported from the Mukanda app's production `authOf`. A header with an
 * authserv-id that is not configured as trusted was written by the sender or
 * by a hop nobody vouches for, and counts for nothing.
 */

/** A verdict as RFC 8601 spells it, plus `unknown` when no trusted server gave one. */
export type AuthVerdict =
  | 'pass'
  | 'fail'
  | 'softfail'
  | 'neutral'
  | 'none'
  | 'temperror'
  | 'permerror'
  | 'policy'
  | 'unknown'

export interface InboundAuthResults {
  /** The authserv-id of the trusted header the verdicts were taken from. Absent when none was trusted. */
  authservId?: string
  spf: AuthVerdict
  dkim: AuthVerdict
  dmarc: AuthVerdict
  /** Domains whose DKIM signature passed (`header.d=`, or the domain of `header.i=`), lower-cased. */
  dkimDomains: string[]
  /** Set when the verdicts came through the ARC seal of this trusted sealer (a forward). */
  arcSealer?: string
}

export interface AuthTrustOptions {
  /** authserv-ids whose `Authentication-Results` are trusted. Default `[]`: every verdict is `unknown`. */
  trustedAuthservIds?: readonly string[]
  /** ARC sealers (`d=` of the seal) whose recorded verdict is trusted for a forward. Default `[]`. */
  trustedArcSealers?: readonly string[]
}

/** A header as postal-mime reports it: lower-cased name, unfolded value. */
export interface HeaderField {
  key: string
  value: string
}

const VERDICTS = new Set<AuthVerdict>(['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy'])

const UNKNOWN: InboundAuthResults = { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', dkimDomains: [] }

/**
 * Removes RFC 5322 comments (`(…)`, nestable) outside quoted strings, so a
 * comment such as `(sender IP is 1.2.3.4; dmarc=pass)` cannot be read as a result.
 */
export function stripComments(value: string): string {
  let out = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (ch === '\\' && (quoted || depth > 0)) {
      if (depth === 0) out += ch + (value[i + 1] ?? '')
      i++
      continue
    }
    if (depth === 0 && ch === '"') {
      quoted = !quoted
      out += ch
      continue
    }
    if (!quoted && ch === '(') {
      depth++
      continue
    }
    if (!quoted && ch === ')' && depth > 0) {
      depth--
      if (depth === 0) out += ' '
      continue
    }
    if (depth === 0) out += ch
  }
  return out
}

/** The `;`-separated segments of a header value, comments removed and trimmed. */
const segmentsOf = (value: string): string[] => stripComments(value).split(';').map((part) => part.trim())

/** The authserv-id of an `Authentication-Results` value: the first token of its first segment. */
export function authservIdOf(value: string): string | undefined {
  const id = segmentsOf(value)[0]?.split(/\s+/)[0]?.toLowerCase()
  return id === undefined || id === '' ? undefined : id
}

interface ResInfo {
  method: string
  result: string
  props: string
}

/** The `method=result props…` entries after the authserv-id. */
function resinfosOf(segments: readonly string[]): ResInfo[] {
  const out: ResInfo[] = []
  for (const segment of segments) {
    const match = /^([a-z0-9][a-z0-9_-]*)(?:\/[0-9]+)?\s*=\s*([a-z]+)\b(.*)$/i.exec(segment)
    if (match) out.push({ method: match[1]!.toLowerCase(), result: match[2]!.toLowerCase(), props: match[3] ?? '' })
  }
  return out
}

function verdictOf(infos: readonly ResInfo[], method: string): AuthVerdict {
  const found = infos.find((info) => info.method === method)
  if (!found) return 'none'
  // `hardfail` is the pre-RFC 7208 spelling of an SPF `fail`.
  if (found.result === 'hardfail') return 'fail'
  return VERDICTS.has(found.result as AuthVerdict) ? (found.result as AuthVerdict) : 'unknown'
}

function dkimDomainsOf(infos: readonly ResInfo[]): string[] {
  const domains = new Set<string>()
  for (const info of infos) {
    if (info.method !== 'dkim' || info.result !== 'pass') continue
    const d = /\bheader\.d\s*=\s*([^\s;]+)/i.exec(info.props)?.[1]
    const i = /\bheader\.i\s*=\s*([^\s;]+)/i.exec(info.props)?.[1]
    const domain = d ?? (i === undefined ? undefined : i.slice(i.lastIndexOf('@') + 1))
    if (domain) domains.add(domain.toLowerCase())
  }
  return [...domains]
}

function resultsFrom(infos: readonly ResInfo[]): Pick<InboundAuthResults, 'spf' | 'dkim' | 'dmarc' | 'dkimDomains'> {
  return {
    spf: verdictOf(infos, 'spf'),
    dkim: verdictOf(infos, 'dkim'),
    dmarc: verdictOf(infos, 'dmarc'),
    dkimDomains: dkimDomainsOf(infos),
  }
}

/** `tag=value` pairs of an ARC header (`i=1; d=google.com; …`). The first `=` splits. */
function tagsOf(value: string): Record<string, string> {
  const tags: Record<string, string> = {}
  for (const part of value.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    if (!(key in tags)) tags[key] = part.slice(eq + 1).trim()
  }
  return tags
}

/**
 * Who authenticated the message, from the headers a TRUSTED server wrote.
 *
 * 1. Only `Authentication-Results` whose authserv-id is in `trustedAuthservIds`
 *    count, and the topmost one wins (a receiving MTA prepends its own). The
 *    trusted MTA must strip incoming headers carrying its own id (RFC 8601 §5).
 * 2. With no trusted header, every verdict is `unknown`.
 * 3. A forward breaks SPF and often DKIM, so DMARC fails at the trusted MTA.
 *    When that MTA reports `arc=pass` and `dmarc` is not `pass`, the highest
 *    `ARC-Seal` is consulted: if its `d=` is a trusted sealer, the
 *    `ARC-Authentication-Results` with the same `i=` gives the verdicts, as
 *    the forwarder saw them before forwarding.
 *
 * Nothing is re-verified here (that would need DNS).
 */
export function authResultsOf(headers: readonly HeaderField[], options: AuthTrustOptions = {}): InboundAuthResults {
  const trusted = new Set((options.trustedAuthservIds ?? []).map((id) => id.toLowerCase()))
  if (trusted.size === 0) return { ...UNKNOWN, dkimDomains: [] }
  const ours = headers.find((header) => header.key === 'authentication-results' && trusted.has(authservIdOf(header.value) ?? ''))
  if (!ours) return { ...UNKNOWN, dkimDomains: [] }

  const authservId = authservIdOf(ours.value)!
  const infos = resinfosOf(segmentsOf(ours.value).slice(1))
  const direct: InboundAuthResults = { authservId, ...resultsFrom(infos) }
  if (direct.dmarc === 'pass' || verdictOf(infos, 'arc') !== 'pass') return direct

  const sealers = new Set((options.trustedArcSealers ?? []).map((sealer) => sealer.toLowerCase()))
  if (sealers.size === 0) return direct
  let last: Record<string, string> | undefined
  for (const header of headers) {
    if (header.key !== 'arc-seal') continue
    const tags = tagsOf(header.value)
    if (!/^[0-9]{1,3}$/.test(tags['i'] ?? '')) continue
    if (last === undefined || Number(tags['i']) > Number(last['i'])) last = tags
  }
  const sealer = last?.['d']?.toLowerCase()
  if (last === undefined || sealer === undefined || !sealers.has(sealer)) return direct

  const theirs = headers.find((header) => {
    if (header.key !== 'arc-authentication-results') return false
    const first = segmentsOf(header.value)[0] ?? ''
    return /^i\s*=\s*([0-9]+)$/i.exec(first)?.[1] === last['i']
  })
  if (!theirs) return direct
  // Segment 0 is `i=N`, segment 1 the sealer's authserv-id, then the results.
  return { authservId, ...resultsFrom(resinfosOf(segmentsOf(theirs.value).slice(2))), arcSealer: sealer }
}
