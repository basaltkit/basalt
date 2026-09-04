import { describe, expect, it } from 'vitest'
import type { RouteMeta } from '@basaltkit/http'
// Importing the plugin is what brings the augmentation into scope — the `can`
// key is declared by this package, not by `@basaltkit/http`.
import '../src/index.js'

/**
 * F-18 · `meta.can` is typed where this plugin is in scope.
 *
 * `RouteMeta` is open — it has to be, or every application's own metadata keys
 * would stop compiling. What each guard plugin adds is the shape of the key it
 * enforces, by augmentation.
 *
 * The check is compile-time, so the assertion *is* the `@ts-expect-error`: if
 * the wrong type ever starts compiling, TypeScript reports the directive as
 * unused and this file fails the build. That only works because this package's
 * `typecheck` includes `tests` — verified, after a first version of this test
 * passed vacuously in a package where the augmentation was not in scope.
 */
describe('F-18 · meta.can', () => {
  it('accepts a permission, or a list of them', () => {
    const uma: RouteMeta = { can: 'matter:read' }
    const varias: RouteMeta = { can: ['matter:read', 'matter:update'] }
    expect(uma['can']).toBe('matter:read')
    expect(varias['can']).toHaveLength(2)
  })

  it('rejects a number', () => {
    // @ts-expect-error `can` is a string or string[]
    const meta: RouteMeta = { can: 123 }
    expect(meta).toBeDefined()
  })

  it('rejects an object', () => {
    // @ts-expect-error `can` is a string or string[]
    const meta: RouteMeta = { can: { permission: 'matter:read' } }
    expect(meta).toBeDefined()
  })
})
