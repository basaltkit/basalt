import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The adapter-agnostic boundary (ecosystem review 2026-08, finding A3).
 *
 * BasaltKit's HTTP contract is neutral: features target `@basaltkit/http`
 * (route/pipeline/guards/enrichers) and run unchanged on Fastify, Express and
 * Hono. This test enforces that invariant structurally — no runtime package may
 * couple itself to one specific adapter, either in its dependency manifest or
 * in its `src/` import graph. Modeled on the dev-only boundary test in
 * `packages/ai-mcp/test/boundary.test.ts`.
 *
 * It lives in `@basaltkit/http` because http *owns* the neutral contract the
 * rule protects, and its suite runs on every CI pass (`turbo run test`).
 *
 * Adapter usage in devDependencies stays legal: feature test-suites boot a real
 * Fastify app via `@basaltkit/testing` until finding Q1 (adapter-parametrized
 * harness) lands.
 */

const ADAPTERS = ['@basaltkit/fastify', '@basaltkit/express', '@basaltkit/hono']

/**
 * Packages allowed to reference a specific adapter. Every entry must be
 * justified — additions to this list should be rare and reviewed.
 */
const ALLOWLIST = new Set([
  // The adapters ARE the adapter-specific packages; binding to their own
  // framework is their entire purpose.
  '@basaltkit/fastify',
  '@basaltkit/express',
  '@basaltkit/hono',
  // The test harness is adapter-parametrizable (finding Q1): it keeps
  // @basaltkit/fastify as a hard dependency because 'fastify' is the
  // backward-compatible default driver (in-process inject), and declares
  // @basaltkit/express + @basaltkit/hono as *optional* peers for the
  // adapter: 'express' | 'hono' drivers. Dev-facing by definition — this
  // entry is permanent, not a debt marker.
  '@basaltkit/testing',
])

/** Manifest fields that force a dependency onto the package's consumers. */
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

interface ManifestLike {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/**
 * Pure checker: adapter entries in consumer-facing dependency fields of
 * non-allowlisted packages. Returned as human-readable violation strings so a
 * failure names the package, the field and the adapter.
 */
export function manifestViolations(manifests: ManifestLike[]): string[] {
  const out: string[] = []
  for (const manifest of manifests) {
    if (ALLOWLIST.has(manifest.name)) continue
    for (const field of RUNTIME_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (ADAPTERS.includes(dep)) out.push(`${manifest.name} → ${field} → ${dep}`)
      }
    }
  }
  return out
}

/**
 * Skip a template literal starting at `start` (source[start] === '`').
 * Returns the index just past the closing backtick. Handles escapes and
 * `${…}` interpolations — including *nested* template literals inside them,
 * which the ai-mcp boundary test's regex-based stripper cannot (codegen files
 * like create-app's templates.ts nest templates and would leak template body
 * as "code", producing false positives).
 */
function skipTemplate(source: string, start: number): number {
  let i = start + 1
  const n = source.length
  while (i < n) {
    const c = source[i]!
    if (c === '\\') {
      i += 2
    } else if (c === '`') {
      return i + 1
    } else if (c === '$' && source[i + 1] === '{') {
      i += 2
      let depth = 1
      while (i < n && depth > 0) {
        const d = source[i]!
        if (d === '\\') {
          i += 2
        } else if (d === '`') {
          i = skipTemplate(source, i)
        } else if (d === "'" || d === '"') {
          // string inside the interpolation — skip it so braces in it don't count
          i += 1
          while (i < n && source[i] !== d) i += source[i] === '\\' ? 2 : 1
          i += 1
        } else {
          if (d === '{') depth += 1
          else if (d === '}') depth -= 1
          i += 1
        }
      }
    } else {
      i += 1
    }
  }
  return i
}

/**
 * Remove comments and template-literal contents, keeping ordinary quoted
 * strings (they carry the import specifiers we must see). Single pass.
 */
export function stripNonCode(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
    } else if (c === "'" || c === '"') {
      out += c
      i += 1
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') {
          out += source[i]! + (source[i + 1] ?? '')
          i += 2
        } else {
          out += source[i]!
          i += 1
        }
      }
      out += c
      i += 1
    } else if (c === '`') {
      i = skipTemplate(source, i)
    } else {
      out += c
      i += 1
    }
  }
  return out
}

/**
 * Extract static + dynamic import/export specifiers from a module's source.
 * Comments and template-literal contents are stripped first, so codegen
 * template content (e.g. `import { route } from '@basaltkit/fastify'` emitted
 * *into* a scaffolded app by create-app/generator) is never mistaken for a
 * real import — same intent as the ai-mcp boundary test, tokenizer-hardened.
 */
export function specifiersOf(source: string): string[] {
  const code = stripNonCode(source)
  const out: string[] = []
  for (const m of code.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]!)
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!)
  return out
}

/** All .ts/.tsx/.mts/.cts files under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full)
  }
  return out
}

/** Adapter specifiers statically imported anywhere under a package's src/. */
export function srcImportViolations(packageName: string, srcDir: string): string[] {
  if (ALLOWLIST.has(packageName) || !existsSync(srcDir)) return []
  const out: string[] = []
  for (const file of sourceFiles(srcDir)) {
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (ADAPTERS.some((a) => spec === a || spec.startsWith(`${a}/`))) {
        out.push(`${packageName} → ${path.relative(srcDir, file)} → ${spec}`)
      }
    }
  }
  return out
}

const here = path.dirname(fileURLToPath(import.meta.url))
const packagesDir = path.resolve(here, '..', '..')

function repoManifests(): { manifest: ManifestLike; dir: string }[] {
  const out: { manifest: ManifestLike; dir: string }[] = []
  for (const entry of readdirSync(packagesDir)) {
    const dir = path.join(packagesDir, entry)
    const manifestPath = path.join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    out.push({ manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestLike, dir })
  }
  return out
}

describe('adapter-agnostic boundary', () => {
  it('scans the real monorepo (sanity: the rule is exercised on real packages)', () => {
    const manifests = repoManifests()
    // If discovery ever breaks (layout change), fail loudly instead of
    // vacuously passing on an empty list.
    expect(manifests.length).toBeGreaterThan(50)
    expect(manifests.some(({ manifest }) => manifest.name === '@basaltkit/auth')).toBe(true)
  })

  it('no runtime package declares a specific adapter in a consumer-facing dependency field', () => {
    const violations = manifestViolations(repoManifests().map(({ manifest }) => manifest))
    expect(violations).toEqual([])
  })

  it('no runtime package statically imports a specific adapter in src/', () => {
    const violations = repoManifests().flatMap(({ manifest, dir }) =>
      srcImportViolations(manifest.name, path.join(dir, 'src')),
    )
    expect(violations).toEqual([])
  })

  // Negative assertions: prove the checkers actually fire on a violation, so a
  // green run above is meaningful.
  it('flags a synthetic manifest violation (dependencies)', () => {
    const violations = manifestViolations([
      { name: '@basaltkit/example', dependencies: { '@basaltkit/fastify': 'workspace:^' } },
    ])
    expect(violations).toEqual(['@basaltkit/example → dependencies → @basaltkit/fastify'])
  })

  it('flags a synthetic manifest violation (peerDependencies) but not devDependencies', () => {
    expect(
      manifestViolations([
        { name: '@basaltkit/example', peerDependencies: { '@basaltkit/hono': '^1.0.0' } },
      ]),
    ).toHaveLength(1)
    expect(
      manifestViolations([
        // devDependencies are deliberately legal (test-only usage, Q1).
        { name: '@basaltkit/example', ...{ devDependencies: { '@basaltkit/fastify': 'workspace:^' } } },
      ]),
    ).toEqual([])
  })

  it('flags a synthetic src import, but not one inside a codegen template literal or comment', () => {
    expect(specifiersOf(`import { route } from '@basaltkit/fastify'`)).toContain('@basaltkit/fastify')
    expect(specifiersOf('const t = `import { route } from \'@basaltkit/fastify\'`')).toEqual([])
    expect(specifiersOf(`// import { route } from '@basaltkit/fastify'`)).toEqual([])
    // Nested template inside an interpolation — the create-app/templates.ts
    // shape that defeats a regex-based stripper.
    const nested =
      'const f = `outer ${cond ? `inner` : other}\n' +
      "import { route } from '@basaltkit/fastify'\n`"
    expect(specifiersOf(nested)).toEqual([])
  })

  it('allowlisted packages are exempt (documented exceptions only)', () => {
    const violations = manifestViolations([
      { name: '@basaltkit/testing', dependencies: { '@basaltkit/fastify': 'workspace:^' } },
    ])
    expect(violations).toEqual([])
  })
})
