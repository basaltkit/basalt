import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, ensureMetadata, runWithContext, tryCtx, type BasaltPlugin } from '@basaltkit/core'
import type { RequestEnricher } from '@basaltkit/http'
import {
  Auth,
  authPlugin,
  authRoutes,
  MemoryUserSource,
  RefreshInvalidError,
  RESERVED_TOKEN_CLAIMS,
  ReservedTokenClaimError,
  tenantBoundTokens,
  totp,
  verifyJwt,
  type AuthUser,
  type NewUser,
  type TokenClaimsContext,
  type UserSource,
} from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

const SECRET = 'x'.repeat(32)

/** Stand-in for @basaltkit/tenancy: resolves ctx().tenant from `x-tenant-id`. */
const headerTenancy = (): BasaltPlugin =>
  definePlugin({
    name: 'test:tenancy',
    register({ container }) {
      const enricher: RequestEnricher = ({ request, context }) => {
        const id = request.headers['x-tenant-id']
        if (typeof id === 'string') (context as { tenant?: { id: string } }).tenant = { id }
      }
      ensureMetadata(container).add('http:enrichers', enricher)
    },
  })

/**
 * Schema-per-tenant in memory: one users table per plane (the context
 * tenant, `''` for the central plane). Rows are inserted with explicit ids, as
 * a data import or a hand-written row would.
 */
class PlaneUsers implements UserSource {
  private readonly planes = new Map<string, Map<string, AuthUser>>()
  private plane(): Map<string, AuthUser> {
    const id = (tryCtx() as { tenant?: { id?: string } } | undefined)?.tenant?.id ?? ''
    let rows = this.planes.get(id)
    if (!rows) this.planes.set(id, (rows = new Map()))
    return rows
  }
  insert(plane: string, user: AuthUser): void {
    if (!this.planes.has(plane)) this.planes.set(plane, new Map())
    this.planes.get(plane)!.set(user.id, user)
  }
  async findByEmail(email: string) {
    return [...this.plane().values()].find((u) => u.email === email) ?? null
  }
  async findById(id: string) {
    return this.plane().get(id) ?? null
  }
  async create(data: NewUser) {
    const user: AuthUser = { id: `u-${this.plane().size + 1}`, ...data, emailVerified: data.emailVerified ?? false }
    this.plane().set(user.id, user)
    return user
  }
}

const seeded = () => {
  const users = new PlaneUsers()
  // The same id on both tenants — the collision schema-per-tenant does not prevent.
  users.insert('acme', { id: 'u-1', email: 'ana@acme.test', passwordHash: 'plain:password123', emailVerified: true })
  users.insert('globex', { id: 'u-1', email: 'gus@globex.test', passwordHash: 'plain:password123', emailVerified: true })
  users.insert('', { id: 'u-1', email: 'ops@platform.test', passwordHash: 'plain:password123', emailVerified: true })
  return users
}

const claimsOf = (token: string) => verifyJwt(token, SECRET)

describe.each(availableAdapters)('tenant-bound access tokens (BK-017, %s)', (adapter) => {
  let harness: Harness | undefined
  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  const setup = async (bind: boolean) => {
    harness = await boot(
      adapter,
      [
        headerTenancy(),
        authPlugin({ users: seeded(), secret: SECRET, hasher: fastHasher, ...(bind ? tenantBoundTokens() : {}) }),
      ],
      authRoutes(),
    )
    return harness
  }
  const login = async (h: Harness, tenant: string | undefined, email: string) => {
    const res = await h.call({
      method: 'POST',
      url: '/auth/login',
      ...(tenant ? { headers: { 'x-tenant-id': tenant } } : {}),
      payload: { email, password: 'password123' },
    })
    expect(res.status).toBe(200)
    return res.body as { accessToken: string; refreshToken: string }
  }
  const me = (h: Harness, token: string, tenant?: string) =>
    h.call({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}`, ...(tenant ? { 'x-tenant-id': tenant } : {}) },
    })

  it('without the binding (default), A’s token is accepted on B for the same id — the old behaviour', async () => {
    const h = await setup(false)
    const { accessToken } = await login(h, 'acme', 'ana@acme.test')
    expect(claimsOf(accessToken)).not.toHaveProperty('tid')
    const res = await me(h, accessToken, 'globex')
    expect(res.status).toBe(200)
    expect(res.body.email).toBe('gus@globex.test') // B's user, resolved from A's token
  })

  it('with tenantBoundTokens(), A’s token is a 401 on B and on the central plane, and still works on A', async () => {
    const h = await setup(true)
    const { accessToken } = await login(h, 'acme', 'ana@acme.test')
    expect(claimsOf(accessToken).tid).toBe('acme')

    const onB = await me(h, accessToken, 'globex')
    expect(onB.status).toBe(401)
    expect(onB.body.code ?? onB.body.error?.code).toBe('AUTH_TOKEN_CLAIMS_REJECTED')
    expect((await me(h, accessToken)).status).toBe(401)

    const onA = await me(h, accessToken, 'acme')
    expect(onA.status).toBe(200)
    expect(onA.body.email).toBe('ana@acme.test')
  })

  it('a central token carries tid: null and is refused on every tenant', async () => {
    const h = await setup(true)
    const { accessToken } = await login(h, undefined, 'ops@platform.test')
    expect(claimsOf(accessToken).tid).toBeNull()
    expect((await me(h, accessToken)).status).toBe(200)
    expect((await me(h, accessToken, 'acme')).status).toBe(401)
  })

  it('a refreshed token keeps the binding', async () => {
    const h = await setup(true)
    const { refreshToken } = await login(h, 'acme', 'ana@acme.test')
    const res = await h.call({
      method: 'POST',
      url: '/auth/refresh',
      headers: { 'x-tenant-id': 'acme' },
      payload: { refreshToken },
    })
    expect(res.status).toBe(200)
    const refreshed = res.body.accessToken as string
    expect(claimsOf(refreshed).tid).toBe('acme')
    expect((await me(h, refreshed, 'acme')).status).toBe(200)
    expect((await me(h, refreshed, 'globex')).status).toBe(401)
  })

  it('a token issued before the binding (no tid) is refused once it is on', async () => {
    const unbound = new Auth({ users: seeded(), secret: SECRET, hasher: fastHasher })
    const { tokens } = await runWithContext({ tenant: { id: 'acme' } }, () => unbound.login('ana@acme.test', 'password123'))
    const h = await setup(true)
    expect((await me(h, tokens.accessToken, 'acme')).status).toBe(401)
  })
})

describe('Auth tokenClaims (BK-017)', () => {
  const register = async (auth: Auth) => auth.register('ada@acme.test', 'password123')

  it('adds the claims on login and re-derives them on every refresh', async () => {
    const seen: TokenClaimsContext[] = []
    let plan = 'pro'
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret: SECRET,
      hasher: fastHasher,
      tokenClaims: (user, context) => {
        seen.push(context)
        return { org: 'acme', plan, uid: user.id }
      },
    })
    const user = await register(auth)
    const { tokens } = await auth.login('ada@acme.test', 'password123')
    expect(claimsOf(tokens.accessToken)).toMatchObject({ sub: user.id, org: 'acme', plan: 'pro', uid: user.id, amr: ['pwd'] })

    plan = 'enterprise'
    const refreshed = await auth.refresh(tokens.refreshToken)
    expect(claimsOf(refreshed.accessToken)).toMatchObject({ sub: user.id, org: 'acme', plan: 'enterprise', amr: ['pwd'] })
    const again = await auth.refresh(refreshed.refreshToken)
    expect(claimsOf(again.accessToken)).toMatchObject({ org: 'acme' })

    expect(seen.map((c) => c.reason)).toEqual(['login', 'refresh', 'refresh'])
    expect(seen[1]!.amr).toEqual(['pwd'])
  })

  it('passes the ambient context (the tenant) to tokenClaims', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, hasher: fastHasher, ...tenantBoundTokens() })
    await register(auth)
    const { tokens } = await runWithContext({ tenant: { id: 'acme' } }, () => auth.login('ada@acme.test', 'password123'))
    expect(claimsOf(tokens.accessToken).tid).toBe('acme')
    // Outside any context: the central plane.
    expect(claimsOf((await auth.refresh(tokens.refreshToken)).accessToken).tid).toBeNull()
  })

  it.each([...RESERVED_TOKEN_CLAIMS])('rejects the reserved claim %s', async (claim) => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, hasher: fastHasher, tokenClaims: () => ({ [claim]: 'x' }) })
    await register(auth)
    await expect(auth.login('ada@acme.test', 'password123')).rejects.toBeInstanceOf(ReservedTokenClaimError)
  })

  it('rejects a non-object result, and a reserved claim name for the binding', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret: SECRET,
      hasher: fastHasher,
      tokenClaims: () => ['nope'] as unknown as Record<string, unknown>,
    })
    await register(auth)
    await expect(auth.login('ada@acme.test', 'password123')).rejects.toBeInstanceOf(TypeError)
    expect(() => tenantBoundTokens({ claim: 'sub' })).toThrow(ReservedTokenClaimError)
    const withReserved = tenantBoundTokens({ tokenClaims: () => ({ exp: 1 }) })
    await expect(withReserved.tokenClaims({ id: 'u', email: 'e', emailVerified: true }, { reason: 'login' })).rejects.toBeInstanceOf(
      ReservedTokenClaimError,
    )
  })

  it('a throwing tokenClaims on refresh leaves the refresh token usable', async () => {
    let fail = false
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret: SECRET,
      hasher: fastHasher,
      tokenClaims: () => {
        if (fail) throw new Error('claims store down')
        return { org: 'acme' }
      },
    })
    await register(auth)
    const { tokens } = await auth.login('ada@acme.test', 'password123')
    fail = true
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow('claims store down')
    fail = false
    const refreshed = await auth.refresh(tokens.refreshToken)
    expect(claimsOf(refreshed.accessToken).org).toBe('acme')
    await expect(auth.refresh('not-a-token')).rejects.toBeInstanceOf(RefreshInvalidError)
  })

  it('MFA completion (login and social login with a code) carries the claims', async () => {
    const seen: TokenClaimsContext[] = []
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret: SECRET,
      hasher: fastHasher,
      loginThrottle: false,
      tokenClaims: (_user, context) => {
        seen.push(context)
        return { org: 'acme' }
      },
    })
    const user = await auth.register('ada@acme.test', 'password123', { emailVerified: true })
    const { secret: totpSecret } = await auth.enrollMfa(user.id)
    const { recoveryCodes } = await auth.activateMfa(user.id, totp(totpSecret))

    const { tokens } = await auth.login('ada@acme.test', 'password123', recoveryCodes[0])
    expect(claimsOf(tokens.accessToken)).toMatchObject({ org: 'acme', amr: ['pwd', 'mfa'] })

    const social = await auth.socialLogin('ada@acme.test', { emailVerified: true, mfaCode: recoveryCodes[1]! })
    expect(claimsOf(social.tokens.accessToken)).toMatchObject({ org: 'acme', amr: ['fed', 'mfa'] })

    expect(seen.map((c) => [c.reason, c.amr])).toEqual([
      ['login', ['pwd', 'mfa']],
      ['social', ['fed', 'mfa']],
    ])
  })

  it('tenantBoundTokens composes the app’s own claims and check', async () => {
    const bound = tenantBoundTokens({
      tokenClaims: () => ({ org: 'acme' }),
      verifyClaims: (claims) => claims['org'] === 'acme',
    })
    const issued = await bound.tokenClaims({ id: 'u', email: 'e', emailVerified: true }, { reason: 'login', request: { tenant: { id: 'acme' } } as never })
    expect(issued).toEqual({ org: 'acme', tid: 'acme' })
    const context = { tenant: { id: 'acme' } } as never
    expect(await bound.verifyClaims({ sub: 'u', iat: 0, tid: 'acme', org: 'acme' }, context)).toBe(true)
    expect(await bound.verifyClaims({ sub: 'u', iat: 0, tid: 'acme', org: 'other' }, context)).toBe(false)
    expect(await bound.verifyClaims({ sub: 'u', iat: 0, tid: 'globex', org: 'acme' }, context)).toBe(false)
    const custom = tenantBoundTokens({ claim: 'tenant' })
    expect(await custom.tokenClaims({ id: 'u', email: 'e', emailVerified: true }, { reason: 'refresh' })).toEqual({ tenant: null })
  })
})
