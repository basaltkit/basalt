import { describe, expect, it } from 'vitest'
import { Container, ensureMetadata } from '@basaltkit/core'
import { route } from '../src/index.js'
import {
  assertRouteMetaValid,
  assertRoutesGuarded,
  GUARDED_META_BUCKET,
  GUARDED_META_KEYS,
  InvalidRouteMetaError,
  META_VALIDATORS_BUCKET,
  UnguardedRouteMetaError,
  type RouteMetaValidator,
} from '../src/guarded-meta.js'
import { isRouteVisible, ROUTE_VISIBILITY_BUCKET, type RouteVisibilityCheck } from '../src/route-visibility.js'

const authRoute = route({ method: 'GET', url: '/me', meta: { auth: true }, handler: async () => ({}) })
const canRoute = route({ method: 'DELETE', url: '/p/:id', meta: { can: 'p:delete' }, handler: async () => ({}) })
const roleRoute = route({ method: 'POST', url: '/team', meta: { teamRole: 'admin' }, handler: async () => ({}) })
const plain = route({ method: 'GET', url: '/health', handler: async () => ({}) })

it('flags meta.mfa: true without authPlugin, never meta.mfa: false', () => {
  const route = (mfa: boolean) => ({ method: 'GET', url: `/m-${mfa}`, meta: { mfa }, handler: () => null }) as never
  expect(() => assertRoutesGuarded([route(true)], new Set())).toThrow(/meta\.mfa \(enforced by authPlugin\)/)
  expect(() => assertRoutesGuarded([route(false)], new Set())).not.toThrow()
  expect(() => assertRoutesGuarded([route(true)], new Set(['mfa']))).not.toThrow()
})

describe('assertRoutesGuarded — security meta declared with no enforcing guard fails at BOOT', () => {
  it('knows the framework security keys', () => {
    expect([...GUARDED_META_KEYS]).toEqual([
      'auth',
      'mfa',
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

describe('assertRoutesGuarded(routes, container) — the check for code that calls runRoute() itself (FA-H25)', () => {
  it('reads the claimed keys from a booted container, as the adapters do', async () => {
    const { createApp, definePlugin, ensureMetadata } = await import('@basaltkit/core')
    const bare = await createApp({ plugins: [] }).boot()
    expect(() => assertRoutesGuarded([authRoute, plain], bare.container)).toThrow(UnguardedRouteMetaError)
    expect(() => assertRoutesGuarded([authRoute], bare.container, ['auth'])).not.toThrow()

    const claimsAuth = definePlugin({
      name: 'test:claims-auth',
      register({ container }) {
        ensureMetadata(container).add(GUARDED_META_BUCKET, 'auth')
      },
    })
    const guarded = await createApp({ plugins: [claimsAuth] }).boot()
    expect(() => assertRoutesGuarded([authRoute, plain], guarded.container)).not.toThrow()
    expect(() => assertRoutesGuarded([canRoute], guarded.container)).toThrow(/meta\.can \(enforced by permissionsPlugin\)/)
  })
})

describe('route-meta validators (http:meta-validators) — FA-044 residual', () => {
  const containerWith = (validators: RouteMetaValidator[], claimed: string[] = []) => {
    const container = new Container()
    const metadata = ensureMetadata(container)
    for (const v of validators) metadata.add(META_VALIDATORS_BUCKET, v)
    for (const k of claimed) metadata.add(GUARDED_META_BUCKET, k)
    return container
  }
  const refuseAdmin: RouteMetaValidator = ({ route: r }) =>
    r.meta?.['teamRole'] === 'Admin' ? 'unknown role "Admin"' : undefined

  it('assertRouteMetaValid collects every problem across routes and validators', () => {
    const container = containerWith([refuseAdmin, ({ route: r }) => (r.url === '/b' ? ['one', 'two'] : undefined)])
    const routes = [
      route({ method: 'GET', url: '/a', meta: { teamRole: 'Admin' }, handler: () => 'a' }),
      route({ method: 'GET', url: '/b', handler: () => 'b' }),
    ]
    try {
      assertRouteMetaValid(routes, container)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRouteMetaError)
      expect((error as InvalidRouteMetaError).problems).toEqual([
        { route: 'GET /a', problem: 'unknown role "Admin"' },
        { route: 'GET /b', problem: 'one' },
        { route: 'GET /b', problem: 'two' },
      ])
    }
  })

  it('assertRoutesGuarded(routes, container) runs the validators — even with allow: true', () => {
    const container = containerWith([refuseAdmin], ['teamRole'])
    const bad = [route({ method: 'GET', url: '/a', meta: { teamRole: 'Admin' }, handler: () => 'a' })]
    expect(() => assertRoutesGuarded(bad, container)).toThrow(InvalidRouteMetaError)
    expect(() => assertRoutesGuarded(bad, container, true)).toThrow(InvalidRouteMetaError)
    // A plain set has no validators to run — the classic claimed-keys check only.
    expect(() => assertRoutesGuarded(bad, new Set(['teamRole']))).not.toThrow()
  })

  it('the unguarded-meta check still runs first and the waiver still waives it', () => {
    const container = containerWith([refuseAdmin])
    const bad = [route({ method: 'GET', url: '/a', meta: { teamRole: 'admin' }, handler: () => 'a' })]
    expect(() => assertRoutesGuarded(bad, container)).toThrow(UnguardedRouteMetaError)
    expect(() => assertRoutesGuarded(bad, container, ['teamRole'])).not.toThrow()
  })
})

describe('isRouteVisible (http:route-visibility)', () => {
  const containerWith = (checks: RouteVisibilityCheck[], claimed: string[] = []) => {
    const container = new Container()
    const metadata = ensureMetadata(container)
    for (const c of checks) metadata.add(ROUTE_VISIBILITY_BUCKET, c)
    for (const k of claimed) metadata.add(GUARDED_META_BUCKET, k)
    return container
  }
  const authed = route({ method: 'GET', url: '/me', meta: { auth: true }, handler: () => 'me' })

  it('hides meta.auth routes from an anonymous caller only when a guard claimed `auth`', async () => {
    expect(await isRouteVisible(authed, {}, containerWith([], ['auth']))).toBe(false)
    expect(await isRouteVisible(authed, { user: { id: 'u' } }, containerWith([], ['auth']))).toBe(true)
    // Edge-auth waiver: no guard claimed `auth`, no user ever appears — never hide.
    expect(await isRouteVisible(authed, {}, containerWith([]))).toBe(true)
    expect(await isRouteVisible(plain, {}, containerWith([], ['auth']))).toBe(true)
  })

  it('a registered check can hide a route; a throwing check hides it (fail closed)', async () => {
    const hide: RouteVisibilityCheck = ({ route: r }) => (r.url === '/health' ? false : undefined)
    expect(await isRouteVisible(plain, {}, containerWith([hide]))).toBe(false)
    expect(await isRouteVisible(authed, { user: { id: 'u' } }, containerWith([hide]))).toBe(true)
    const boom: RouteVisibilityCheck = async () => {
      throw new Error('store down')
    }
    expect(await isRouteVisible(plain, {}, containerWith([boom]))).toBe(false)
  })
})
