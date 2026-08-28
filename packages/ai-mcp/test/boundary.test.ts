import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The dev-only boundary: `@basaltkit/ai-mcp` must never drag the framework
 * *runtime* into its dependency graph. It may depend only on `@basaltkit/ai`
 * (its dev-only public API) and the zero-dependency `@basaltkit/mcp-core`.
 */
const FORBIDDEN = ['@basaltkit/core', '@basaltkit/http', '@basaltkit/mcp', '@basaltkit/cli']

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

/**
 * Skip a template literal starting at `start` (source[start] === '`').
 * Returns the index just past the closing backtick. Handles escapes and
 * `${…}` interpolations — including *nested* template literals inside them,
 * which a regex-based stripper cannot: it closes the template at the first
 * nested backtick and leaks template body as "code", producing phantom (or
 * hiding real) imports. The ai/generator codegen sources this test walks nest
 * templates heavily. Same tokenizer as packages/http/tests/adapter-boundary.test.ts
 * (kept as a deliberate duplicate — two copies of test-only tooling don't yet
 * justify a shared package; extract if a third copy appears).
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
function stripNonCode(source: string): string {
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
 * string content (e.g. `import { db } from '@basaltkit/prisma'` emitted *into*
 * generated files) is never mistaken for a real import of this package.
 */
function specifiersOf(source: string): string[] {
  const code = stripNonCode(source)
  const out: string[] = []
  for (const m of code.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]!)
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!)
  return out
}

/** Resolve a bare specifier (honouring package `exports`) to a filesystem path, or null. */
function resolveBare(spec: string, parent: string): string | null {
  const resolve = import.meta.resolve as (s: string, p?: string) => string
  // Try the 2-arg form (resolve relative to the importing file); fall back to
  // the stable 1-arg form (relative to this test module — same package, same deps).
  for (const attempt of [() => resolve(spec, parent), () => resolve(spec)]) {
    try {
      const url = attempt()
      if (url?.startsWith('file:')) return fileURLToPath(url)
    } catch {
      /* try next */
    }
  }
  return null
}

/** Resolve a relative specifier against a source dir, tolerating .js↔.ts and /index. */
function resolveRelative(spec: string, fromDir: string): string | null {
  const base = path.resolve(fromDir, spec.replace(/\.js$/, ''))
  for (const cand of [base + '.ts', base + '.js', path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
    try {
      readFileSync(cand)
      return cand
    } catch {
      /* try next */
    }
  }
  return null
}

/** Walk the transitive import graph from the given entry files; collect bare specifiers. */
function walk(entryFiles: string[]): Set<string> {
  const seen = new Set<string>()
  const bare = new Set<string>()
  const queue = [...entryFiles]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    let code: string
    try {
      code = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const parentUrl = pathToFileURL(file).href
    for (const spec of specifiersOf(code)) {
      if (spec.startsWith('node:')) continue
      if (spec.startsWith('.')) {
        const rel = resolveRelative(spec, path.dirname(file))
        if (rel) queue.push(rel)
      } else {
        bare.add(spec)
        const resolved = resolveBare(spec, parentUrl)
        if (resolved) queue.push(resolved)
      }
    }
  }
  return bare
}

describe('dev-only boundary', () => {
  it('declares exactly @basaltkit/ai + @basaltkit/mcp-core as dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['@basaltkit/ai', '@basaltkit/mcp-core'])
  })

  it('never transitively imports the framework runtime (core/http) or the runtime mcp/cli', () => {
    const entries = [path.join(here, '..', 'src', 'index.ts'), path.join(here, '..', 'src', 'bin.ts')]
    const bare = walk(entries)
    // sanity: the walk reached the framework-free ai subpaths AND recursed transitively
    // through workflows into the generator's framework-free /resource subpath.
    expect(bare.has('@basaltkit/ai/analysis')).toBe(true)
    expect(bare.has('@basaltkit/ai/workflows')).toBe(true)
    expect(bare.has('@basaltkit/generator/resource')).toBe(true)
    for (const forbidden of FORBIDDEN) {
      expect([...bare].some((s) => s === forbidden || s.startsWith(`${forbidden}/`))).toBe(false)
    }
  })
})
