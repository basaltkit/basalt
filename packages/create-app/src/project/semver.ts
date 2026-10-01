/**
 * The small slice of semver the project commands need — no dependency: parse a
 * stable `x.y.z`, read a simple dependency range, classify an update, and test
 * `satisfies` for the range grammar package.json files actually use (`^`, `~`,
 * comparators, `x` wildcards, hyphen-less `||` unions).
 */

export type Version = readonly [number, number, number]

const STABLE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Parses `1.2.3` (a leading `v`, pre-release and build metadata are tolerated and ignored). */
export function parseVersion(text: string): Version | undefined {
  const match = STABLE.exec(text.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** A dependency range `update` knows how to rewrite: `^1.2.3`, `~1.2.3` or an exact `1.2.3`. */
export interface SimpleRange {
  style: '^' | '~' | ''
  version: string
  parsed: Version
}

export function parseSimpleRange(range: string): SimpleRange | undefined {
  const trimmed = range.trim()
  const style = trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : ''
  const version = trimmed.slice(style.length)
  if (!/^\d+\.\d+\.\d+$/.test(version)) return undefined
  const parsed = parseVersion(version)
  return parsed ? { style, version, parsed } : undefined
}

export type UpdateKind = 'patch' | 'minor' | 'major'

/**
 * How big a move from `from` to `to` is. Under caret semantics a `0.x` minor
 * is breaking, so `0.2.0 → 0.3.0` counts as a major.
 */
export function updateKind(from: Version, to: Version): UpdateKind {
  if (from[0] !== to[0]) return 'major'
  if (from[0] === 0 && from[1] !== to[1]) return 'major'
  if (from[1] !== to[1]) return 'minor'
  return 'patch'
}

type Comparator = { op: '>=' | '>' | '<=' | '<' | '='; version: Version }

/** Expands one range token (`^1.2.3`, `~1.2`, `>=22.5.0`, `22.x`, `1.2.3`) into comparators. */
function comparators(token: string): Comparator[] | undefined {
  if (token === '' || token === '*' || token === 'x' || token === 'latest') return []
  const op = /^(>=|<=|>|<|=|\^|~)?v?(.*)$/.exec(token)
  if (!op) return undefined
  const operator = op[1] ?? ''
  const parts = (op[2] ?? '').split('.')
  if (parts.length > 3) return undefined
  const wild = (part: string | undefined): boolean => part === undefined || part === 'x' || part === 'X' || part === '*'
  const nums: number[] = []
  for (const part of parts) {
    if (wild(part)) break
    const core = part.split('-')[0] ?? ''
    if (!/^\d+$/.test(core)) return undefined
    nums.push(Number(core))
  }
  const [major, minor, patch] = nums
  if (major === undefined) return operator === '<' || operator === '>' ? undefined : []
  const floor: Version = [major, minor ?? 0, patch ?? 0]
  if (operator === '^') {
    const ceil: Version =
      major > 0 || minor === undefined
        ? [major + 1, 0, 0]
        : minor > 0 || patch === undefined
          ? [0, minor + 1, 0]
          : [0, 0, patch + 1]
    return [
      { op: '>=', version: floor },
      { op: '<', version: ceil },
    ]
  }
  if (operator === '~' || (operator === '' && patch === undefined)) {
    const ceil: Version = minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0]
    return [
      { op: '>=', version: floor },
      { op: '<', version: ceil },
    ]
  }
  if (operator === '' || operator === '=') return [{ op: '=', version: floor }]
  return [{ op: operator as Comparator['op'], version: floor }]
}

const holds = (version: Version, { op, version: bound }: Comparator): boolean => {
  const order = compareVersions(version, bound)
  switch (op) {
    case '>=':
      return order >= 0
    case '>':
      return order > 0
    case '<=':
      return order <= 0
    case '<':
      return order < 0
    default:
      return order === 0
  }
}

/**
 * Whether `version` satisfies `range`. Returns `undefined` for a range this
 * subset cannot read (a `workspace:`/`npm:`/git/file spec, a hyphen range) —
 * callers treat that as "cannot tell", never as a failure.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const parsed = parseVersion(version)
  if (!parsed) return undefined
  if (/^(workspace|npm|file|link|git|github|http|https):/.test(range) || / - /.test(range)) return undefined
  let readable = false
  for (const alternative of range.split('||')) {
    // `>= 1.2.3` → `>=1.2.3`: glue an operator to its version before splitting.
    const tokens = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/)
    const all: Comparator[] = []
    let ok = true
    for (const token of tokens) {
      const expanded = comparators(token)
      if (!expanded) {
        ok = false
        break
      }
      all.push(...expanded)
    }
    if (!ok) continue
    readable = true
    if (all.every((comparator) => holds(parsed, comparator))) return true
  }
  return readable ? false : undefined
}
