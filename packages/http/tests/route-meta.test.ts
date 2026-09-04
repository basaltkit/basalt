import { describe, expect, it } from 'vitest'
import { route, type RouteMeta } from '../src/index.js'

/**
 * F-18 · `meta` has a shape.
 *
 * It was `Record<string, unknown>`: no key was known to the compiler, so
 * `can: 123` compiled, and so did every misspelling.
 *
 * `RouteMeta` stays open — the index signature keeps existing routes compiling,
 * and applications legitimately add their own keys. What it buys is the shape
 * of the keys the toolkit knows, declared by each guard plugin through
 * augmentation.
 *
 * The misspelt-key case is deliberately NOT closed here: an index signature has
 * to accept unknown names. It is closed at boot instead — the adapters refuse
 * to start on a guard key with no plugin behind it, and `subscriptionsPlugin`
 * refuses on a plan absent from the catalogue (F-17).
 */
describe('F-18 · RouteMeta', () => {
  it('accepts keys the application invents', () => {
    // The escape hatch has to keep working: apps put their own markers here,
    // and a closed type would break every one of them.
    const meta: RouteMeta = { minhaChave: 'valor', outra: 42 }
    expect(meta['minhaChave']).toBe('valor')
  })

  it('carries through route() unchanged', () => {
    const r = route({
      method: 'GET',
      url: '/x',
      meta: { auth: true, can: 'matter:read' },
      handler: () => ({}),
    })
    expect(r.meta).toEqual({ auth: true, can: 'matter:read' })
  })

  it('still allows a misspelt key, and says so', () => {
    // Documented, not accidental: an index signature has to accept unknown
    // names. The boot checks are what catch this.
    const meta: RouteMeta = { subcribed: 'pro' }
    expect(meta['subcribed']).toBe('pro')
  })

  it('knows nothing about `can` from here — the plugin owns that key', () => {
    /**
     * A first version of this test asserted `@ts-expect-error` on `can: 123`
     * and passed. It passed **vacuously**: `can` is declared by
     * `@basaltkit/permissions`, which this package does not import, so nothing
     * was being suppressed. Removing the directive produced no error at all.
     *
     * The typing works where the plugin is in scope — see the test in
     * `permissions` — and this package deliberately knows only the base shape.
     * Asserting that here keeps the boundary honest.
     */
    const meta: RouteMeta = { can: 123 }
    expect(meta['can']).toBe(123)
  })
})
