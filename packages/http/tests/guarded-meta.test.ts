import { describe, expect, it } from 'vitest'
import { route } from '../src/index.js'
import { assertRoutesGuarded, GUARDED_META_KEYS, UnguardedRouteMetaError } from '../src/guarded-meta.js'

const authRoute = route({ method: 'GET', url: '/me', meta: { auth: true }, handler: async () => ({}) })
const canRoute = route({ method: 'DELETE', url: '/p/:id', meta: { can: 'p:delete' }, handler: async () => ({}) })
const roleRoute = route({ method: 'POST', url: '/team', meta: { teamRole: 'admin' }, handler: async () => ({}) })
const plain = route({ method: 'GET', url: '/health', handler: async () => ({}) })

describe('assertRoutesGuarded — security meta declared with no enforcing guard fails at BOOT', () => {
  it('knows the framework security keys', () => {
    expect([...GUARDED_META_KEYS]).toEqual([
      'auth',
      'can',
      'teamRole',
      'scopes',
      'subscribed',
      'feature',
    ])
  })

  it('names the enforcing plugin for every guarded key, so the boot error is actionable', () => {
    for (const [key, plugin] of [
      ['auth', 'authPlugin'],
      ['can', 'permissionsPlugin'],
      ['teamRole', 'teamsPlugin'],
      ['scopes', 'apiKeysPlugin'],
      ['subscribed', 'subscriptionsPlugin'],
      ['feature', 'subscriptionsPlugin'],
    ] as const) {
      const offender = route({
        method: 'GET',
        url: `/${key}`,
        meta: { [key]: key === 'scopes' ? ['read'] : true },
        handler: async () => ({}),
      })
      try {
        assertRoutesGuarded([offender], new Set())
        expect.unreachable()
      } catch (error) {
        expect((error as Error).message).toContain(plugin)
      }
    }
  })

  it('throws when meta.auth is declared and nothing claimed "auth"', () => {
    expect(() => assertRoutesGuarded([authRoute, plain], new Set())).toThrow(UnguardedRouteMetaError)
    try {
      assertRoutesGuarded([authRoute], new Set())
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('GET /me')
      expect(message).toContain('auth')
      expect(message).toContain('allowUnguardedMeta')
    }
  })

  it('aggregates every offending route/key into ONE boot error', () => {
    try {
      assertRoutesGuarded([authRoute, canRoute, roleRoute], new Set(['auth']))
      expect.unreachable()
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain('GET /me') // auth is claimed
      expect(message).toContain('DELETE /p/:id')
      expect(message).toContain('POST /team')
    }
  })

  it('passes when the enforcing plugins claimed their keys', () => {
    expect(() =>
      assertRoutesGuarded([authRoute, canRoute, roleRoute, plain], new Set(['auth', 'can', 'teamRole'])),
    ).not.toThrow()
  })

  it('ignores meta.auth === false and undefined (an explicit opt-off is not a protection claim)', () => {
    const off = route({ method: 'GET', url: '/pub', meta: { auth: false }, handler: async () => ({}) })
    expect(() => assertRoutesGuarded([off, plain], new Set())).not.toThrow()
  })

  it('allowUnguardedMeta: true waives everything (edge-auth deployments)', () => {
    expect(() => assertRoutesGuarded([authRoute, canRoute], new Set(), true)).not.toThrow()
  })

  it('allowUnguardedMeta: [key] waives only that key', () => {
    expect(() => assertRoutesGuarded([authRoute], new Set(), ['auth'])).not.toThrow()
    expect(() => assertRoutesGuarded([authRoute, canRoute], new Set(), ['auth'])).toThrow(UnguardedRouteMetaError)
  })

  it('non-security meta keys are never flagged', () => {
    const metered = route({ method: 'GET', url: '/m', meta: { rateLimit: { max: 1 } }, handler: async () => ({}) })
    expect(() => assertRoutesGuarded([metered], new Set())).not.toThrow()
  })
})
