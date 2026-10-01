/**
 * package.json edits that keep the file looking like the user left it.
 *
 * - {@link setDependencyRange} rewrites ONE range in place (text-level): key
 *   order, indentation, line endings and every other byte stay untouched.
 * - {@link mergePackageJson} adds dependencies/scripts (structural): the file is
 *   re-serialized with its own indentation and trailing newline, new keys of an
 *   alphabetically sorted dependency section are slotted in order, and an
 *   existing entry is never changed.
 */

export const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number]

export interface PackageJson {
  name?: string
  version?: string
  packageManager?: string
  engines?: Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

/** Index just past the value starting at `start` (a string, object, array or literal). */
function skipValue(text: string, start: number): number {
  let i = start
  while (/\s/.test(text[i] ?? '')) i++
  const first = text[i]
  if (first === '"') {
    i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    return i + 1
  }
  if (first === '{' || first === '[') {
    let depth = 0
    for (; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"') {
        i = skipValue(text, i) - 1
      } else if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return i + 1
      }
    }
    return text.length
  }
  while (i < text.length && !/[,}\]\s]/.test(text[i] ?? '')) i++
  return i
}

/**
 * The `[start, end)` span of a top-level key's VALUE in a JSON object text, or
 * undefined. Walks the top level only, so a nested key of the same name (an
 * `overrides.dependencies`) never matches.
 */
export function topLevelValueSpan(text: string, key: string): [number, number] | undefined {
  let i = text.indexOf('{')
  if (i === -1) return undefined
  i++
  while (i < text.length) {
    while (/[\s,]/.test(text[i] ?? '')) i++
    if (text[i] !== '"') return undefined
    const keyEnd = skipValue(text, i)
    const name = JSON.parse(text.slice(i, keyEnd)) as string
    i = keyEnd
    while (/\s/.test(text[i] ?? '')) i++
    if (text[i] !== ':') return undefined
    i++
    while (/\s/.test(text[i] ?? '')) i++
    const valueEnd = skipValue(text, i)
    if (name === key) return [i, valueEnd]
    i = valueEnd
  }
  return undefined
}

/**
 * Rewrites `section[name]` to `range`, touching only that string. Returns the
 * text unchanged when the entry is not there.
 */
export function setDependencyRange(text: string, section: string, name: string, range: string): string {
  const span = topLevelValueSpan(text, section)
  if (!span) return text
  const [start, end] = span
  const body = text.slice(start, end)
  const inner = topLevelValueSpan(body, name)
  if (!inner) return text
  const [valueStart, valueEnd] = inner
  return text.slice(0, start) + body.slice(0, valueStart) + JSON.stringify(range) + body.slice(valueEnd) + text.slice(end)
}

/** The indentation unit of a JSON text (default two spaces). */
export function detectIndent(text: string): string {
  const match = /^[ \t]+(?=")/m.exec(text)
  return match ? match[0] : '  '
}

const isSorted = (keys: readonly string[]): boolean => keys.every((key, i) => i === 0 || (keys[i - 1] as string) <= key)

export interface PackageJsonAdditions {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  /** New scripts. An existing script of the same name is kept (see `replaceScripts`). */
  scripts?: Record<string, string>
  /** Scripts to overwrite: name → { from, to }; replaced only while still `from`. */
  replaceScripts?: Record<string, { from: string; to: string }>
}

export interface MergeResult {
  text: string
  /** What was added/changed, for the plan. */
  changes: string[]
  /** What was left alone because the user already has something else there. */
  kept: string[]
}

/** Adds dependencies and scripts; never changes an existing entry. */
export function mergePackageJson(text: string, additions: PackageJsonAdditions): MergeResult {
  const pkg = JSON.parse(text) as PackageJson
  const changes: string[] = []
  const kept: string[] = []
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const wanted = additions[section]
    if (!wanted) continue
    const current = { ...(pkg[section] ?? {}) }
    const sorted = isSorted(Object.keys(current))
    let added = false
    for (const [name, range] of Object.entries(wanted)) {
      const elsewhere = section === 'dependencies' ? pkg.devDependencies?.[name] : pkg.dependencies?.[name]
      if (current[name] !== undefined || elsewhere !== undefined) {
        if ((current[name] ?? elsewhere) !== range) kept.push(`${name} (kept ${current[name] ?? elsewhere})`)
        continue
      }
      current[name] = range
      changes.push(`${section}: + ${name}@${range}`)
      added = true
    }
    if (added) pkg[section] = sorted ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : current
  }
  const scripts = { ...(pkg.scripts ?? {}) }
  let scriptsChanged = false
  for (const [name, command] of Object.entries(additions.scripts ?? {})) {
    if (scripts[name] !== undefined) {
      if (scripts[name] !== command) kept.push(`script "${name}" (kept "${scripts[name]}")`)
      continue
    }
    scripts[name] = command
    changes.push(`scripts: + ${name}: ${command}`)
    scriptsChanged = true
  }
  for (const [name, { from, to }] of Object.entries(additions.replaceScripts ?? {})) {
    if (scripts[name] === from) {
      scripts[name] = to
      changes.push(`scripts: ${name}: ${from} → ${to}`)
      scriptsChanged = true
    } else if (scripts[name] === undefined) {
      scripts[name] = to
      changes.push(`scripts: + ${name}: ${to}`)
      scriptsChanged = true
    } else if (scripts[name] !== to) {
      kept.push(`script "${name}" (kept "${scripts[name]}")`)
    }
  }
  if (scriptsChanged) pkg.scripts = scripts
  if (changes.length === 0) return { text, changes, kept }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let out = JSON.stringify(pkg, null, detectIndent(text))
  if (eol !== '\n') out = out.replaceAll('\n', eol)
  return { text: text.endsWith('\n') ? out + eol : out, changes, kept }
}
