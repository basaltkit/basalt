/**
 * The `.env` as a document: read without a shell (no `$` expansion, no command
 * substitution), edited in place (a key keeps its line, comments survive), and
 * written in a form Node's `--env-file`, `dotenv` and `docker compose
 * --env-file` all read the same way.
 *
 * Problems are reported by line number, never by value: the file holds secrets
 * and the report ends up in terminals, CI logs and screenshots.
 */

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export type EnvLine =
  | { kind: 'pair'; key: string; value: string; raw: string }
  | { kind: 'other'; raw: string }

export interface EnvProblem {
  line: number
  message: string
}

export interface EnvDocument {
  lines: EnvLine[]
  problems: EnvProblem[]
}

export function parseEnv(text: string): EnvDocument {
  const lines: EnvLine[] = []
  const problems: EnvProblem[] = []
  const seen = new Map<string, number>()
  const rows = text.replace(/\r\n/g, '\n').split('\n')
  if (rows.at(-1) === '') rows.pop()

  rows.forEach((raw, index) => {
    const number = index + 1
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      lines.push({ kind: 'other', raw })
      return
    }
    const match = /^\s*(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(raw)
    if (!match) {
      // The incident that wrote this check: a prompt's echo split `KEY="…`
      // over two lines, and Compose refused the file (`unexpected character`).
      problems.push({ line: number, message: 'not a KEY=value line (a value split over two lines?)' })
      lines.push({ kind: 'other', raw })
      return
    }
    const key = match[1] as string
    if (!ENV_KEY.test(key)) {
      problems.push({ line: number, message: `"${key}" is not a valid variable name` })
      lines.push({ kind: 'other', raw })
      return
    }
    const value = parseValue((match[2] as string).trim())
    if (value === null) {
      problems.push({ line: number, message: `${key}: the quoted value is not closed on the same line` })
      lines.push({ kind: 'other', raw })
      return
    }
    const earlier = seen.get(key)
    if (earlier !== undefined) {
      problems.push({ line: number, message: `${key} is already set on line ${earlier}; tools disagree on which one wins` })
    }
    seen.set(key, number)
    lines.push({ kind: 'pair', key, value, raw })
  })
  return { lines, problems }
}

/** `null` when a quote opens and does not close on the line. */
function parseValue(rest: string): string | null {
  if (rest.startsWith('"')) {
    let out = ''
    for (let i = 1; i < rest.length; i++) {
      const c = rest[i] as string
      if (c === '\\' && i + 1 < rest.length) {
        const next = rest[++i] as string
        out += next === 'n' ? '\n' : next
        continue
      }
      if (c === '"') return out
      out += c
    }
    return null
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1)
    return end === -1 ? null : rest.slice(1, end)
  }
  const comment = rest.search(/\s#/)
  return (comment === -1 ? rest : rest.slice(0, comment)).trim()
}

export function envValues(document: EnvDocument): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of document.lines) if (line.kind === 'pair') values.set(line.key, line.value)
  return values
}

const SAFE = /^[A-Za-z0-9_./:@%+,=?&~*-]*$/

export class UnwritableValueError extends Error {
  constructor(readonly key: string) {
    super(`${key}: the value has both a single quote and one of " \\ $ or a line break — no quoting reads the same in Node, dotenv and Compose. Choose another value.`)
    this.name = 'UnwritableValueError'
  }
}

/** A value in the one form every reader agrees on, or {@link UnwritableValueError}. */
export function formatValue(value: string, key = 'value'): string {
  if (SAFE.test(value)) return value
  if (value.includes('\n')) throw new UnwritableValueError(key)
  // Single quotes are literal for Node, dotenv and Compose alike (no `$` interpolation).
  if (!value.includes("'")) return `'${value}'`
  // Double quotes: literal everywhere only without `"`, `\` and `$` (Compose interpolates `$`, Node keeps `\`).
  if (!/["\\$]/.test(value)) return `"${value}"`
  throw new UnwritableValueError(key)
}

export type EnvChange =
  | { kind: 'set'; key: string; value: string; reason: string }
  | { kind: 'remove'; key: string; reason: string }

/** Applies changes: a set key keeps its line, a new key is appended, a removed key's line goes. */
export function applyEnvChanges(document: EnvDocument, changes: EnvChange[]): string {
  const sets = new Map<string, string>()
  const removes = new Set<string>()
  for (const change of changes) {
    if (change.kind === 'set') sets.set(change.key, change.value)
    else removes.add(change.key)
  }
  const out: string[] = []
  const written = new Set<string>()
  for (const line of document.lines) {
    if (line.kind !== 'pair') { out.push(line.raw); continue }
    if (removes.has(line.key)) continue
    if (sets.has(line.key)) {
      if (written.has(line.key)) continue
      out.push(`${line.key}=${formatValue(sets.get(line.key) as string, line.key)}`)
      written.add(line.key)
      continue
    }
    out.push(line.raw)
  }
  const appended = [...sets].filter(([key]) => !written.has(key))
  if (appended.length > 0) {
    if (out.length > 0 && out.at(-1) !== '') out.push('')
    out.push(`# Added by basalt-deploy`)
    for (const [key, value] of appended) out.push(`${key}=${formatValue(value, key)}`)
  }
  return `${out.join('\n')}\n`
}
