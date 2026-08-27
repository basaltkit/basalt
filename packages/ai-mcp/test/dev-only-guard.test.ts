import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * RFC 0001 §D.4 — the AI layer is DEV-ONLY. `@basaltkit/ai` and `@basaltkit/ai-mcp`
 * may appear only in `devDependencies` of other workspace packages, never in
 * `dependencies` or `peerDependencies` — so they can never leak into an app's
 * runtime graph. The `ai`/`ai-mcp` packages themselves are exempt.
 */
const GUARDED = ['@basaltkit/ai', '@basaltkit/ai-mcp']
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies'] as const

interface Pkg {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** Return every dev-only violation in a package manifest (empty = clean). */
export function devOnlyViolations(pkg: Pkg): string[] {
  if (pkg.name && GUARDED.includes(pkg.name)) return [] // the guarded packages themselves are exempt
  const out: string[] = []
  for (const field of RUNTIME_FIELDS) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (GUARDED.includes(dep)) out.push(`${pkg.name ?? '(unnamed)'}: ${dep} in ${field}`)
    }
  }
  return out
}

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('dev-only guard (RFC §D.4)', () => {
  it('no workspace package lists @basaltkit/ai or @basaltkit/ai-mcp as a runtime dependency', () => {
    const violations: string[] = []
    for (const entry of readdirSync(packagesDir)) {
      const manifest = join(packagesDir, entry, 'package.json')
      if (!existsSync(manifest)) continue
      violations.push(...devOnlyViolations(JSON.parse(readFileSync(manifest, 'utf8')) as Pkg))
    }
    expect(violations).toEqual([])
  })

  it('flags a runtime dependency on the AI layer (proves the guard goes red)', () => {
    expect(devOnlyViolations({ name: '@basaltkit/some-app', dependencies: { '@basaltkit/ai': '^1' } })).toEqual([
      '@basaltkit/some-app: @basaltkit/ai in dependencies',
    ])
    expect(devOnlyViolations({ name: '@basaltkit/x', peerDependencies: { '@basaltkit/ai-mcp': '^0.1' } })).toEqual([
      '@basaltkit/x: @basaltkit/ai-mcp in peerDependencies',
    ])
    // devDependency is allowed; the guarded packages themselves are exempt
    expect(devOnlyViolations({ name: '@basaltkit/x', devDependencies: { '@basaltkit/ai': '^1' } })).toEqual([])
    expect(devOnlyViolations({ name: '@basaltkit/ai-mcp', dependencies: { '@basaltkit/ai': 'workspace:^' } })).toEqual([])
  })
})
