import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { permissionMatches, permitted } from '../src/match.js'

/**
 * F-21 · The matching rule, reachable from a browser.
 *
 * `permissionMatches` was implemented and exported, and unreachable from a
 * frontend: the package has a single entry point and depends on
 * `@basaltkit/core`, which imports `node:async_hooks` and `node:crypto`.
 * Importing the function pulled the whole Node runtime.
 *
 * So every frontend rewrote the rule, and the rewrites drifted. One seen in the
 * wild handled `resource:*` and missed the global `'*'` — which hides controls
 * from exactly the people allowed to use them. Not a security hole (the server
 * still decides) but a UI that lies about what you can do.
 */
describe('F-21 · @basaltkit/permissions/match imports nothing', () => {
  it('the source file has no imports at all', () => {
    // The guard the subpath exists for. One `import` here and the file drags
    // `core` back in, and with it `node:async_hooks` — and the failure shows up
    // in someone else's bundler.
    const source = readFileSync(new URL('../src/match.ts', import.meta.url), 'utf8')
    const rows = source.split('\n').filter((l) => /^\s*import\b/.test(l))
    expect(rows).toEqual([])
  })
})

describe('F-21 · the rule itself', () => {
  it('matches exactly', () => {
    expect(permissionMatches('matter:read', 'matter:read')).toBe(true)
    expect(permissionMatches('matter:read', 'matter:write')).toBe(false)
  })

  it('matches a wildcard in any segment', () => {
    expect(permissionMatches('matter:*', 'matter:delete')).toBe(true)
    expect(permissionMatches('*:read', 'matter:read')).toBe(true)
  })

  it('matches the global wildcard', () => {
    // The case the hand-written frontend copy missed.
    expect(permissionMatches('*', 'matter:read')).toBe(true)
    expect(permissionMatches('*', 'anything:at:all')).toBe(true)
  })

  it('does not match across different segment counts', () => {
    expect(permissionMatches('matter:*', 'matter:read:own')).toBe(false)
  })

  it('permitted() answers over a list', () => {
    // What a frontend actually asks: "given what I hold, can I do this?"
    const concedidas = ['matter:*', 'contact:read']
    expect(permitted(concedidas, 'matter:delete')).toBe(true)
    expect(permitted(concedidas, 'contact:read')).toBe(true)
    expect(permitted(concedidas, 'invoice:read')).toBe(false)
    expect(permitted([], 'matter:read')).toBe(false)
  })
})
