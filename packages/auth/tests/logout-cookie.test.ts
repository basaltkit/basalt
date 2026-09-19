import { afterEach, describe, expect, it } from 'vitest'
import { MemoryUserSource, authPlugin, authRoutes } from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/**
 * BK-017: `POST /auth/logout` must end a cookie-only session (a SPA that never
 * sees a refresh token), still revoke a refresh token when one is given, and
 * keep the session cookie behind the CSRF defence.
 */

const secret = 'test-secret-test-secret-test-secret'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(adapter: (typeof availableAdapters)[number]) {
  harness = await boot(
    adapter,
    [authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher })],
    authRoutes({ rateLimit: false }),
  )
  const h = harness
  await h.call({ method: 'POST', url: '/auth/register', payload: { email: 'spa@acme.test', password: 'password123' } })
  const login = await h.call({ method: 'POST', url: '/auth/login', payload: { email: 'spa@acme.test', password: 'password123' } })
  const setCookie = login.headers['set-cookie']
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!
  return { h, cookie, refreshToken: login.body.refreshToken as string }
}

const expiredCookie = (res: { headers: Record<string, string | string[] | undefined> }) =>
  String(res.headers['set-cookie'] ?? '').includes('Max-Age=0')

describe.each(availableAdapters)('POST /auth/logout (%s)', (adapter) => {
  it('ends a cookie-only session with NO body and expires the cookie', async () => {
    const { h, cookie } = await setup(adapter)
    expect((await h.call({ method: 'GET', url: '/auth/me', headers: { cookie } })).status).toBe(200)

    const out = await h.call({ method: 'POST', url: '/auth/logout', headers: { cookie, 'sec-fetch-site': 'same-origin' } })
    expect(out.status).toBe(204)
    expect(expiredCookie(out)).toBe(true)
    expect((await h.call({ method: 'GET', url: '/auth/me', headers: { cookie } })).status).toBe(401)
  })

  it('accepts an empty JSON body with the cookie', async () => {
    const { h, cookie } = await setup(adapter)
    const out = await h.call({ method: 'POST', url: '/auth/logout', headers: { cookie }, payload: {} })
    expect(out.status).toBe(204)
    expect((await h.call({ method: 'GET', url: '/auth/me', headers: { cookie } })).status).toBe(401)
  })

  it('still revokes the refresh token when one is provided', async () => {
    const { h, refreshToken } = await setup(adapter)
    const out = await h.call({ method: 'POST', url: '/auth/logout', payload: { refreshToken } })
    expect(out.status).toBe(204)
    const refresh = await h.call({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } })
    expect(refresh.status).toBe(401)
  })

  it('refuses a cross-site cookie-only logout (CSRF) and keeps the session', async () => {
    const { h, cookie } = await setup(adapter)
    const forged = await h.call({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    })
    expect(forged.status).toBe(403)
    expect(forged.body.error.code).toBe('AUTH_CSRF_REJECTED')
    expect((await h.call({ method: 'GET', url: '/auth/me', headers: { cookie } })).status).toBe(200)
  })

  it('a cross-site request with a refresh token revokes the token but not the cookie session', async () => {
    const { h, cookie, refreshToken } = await setup(adapter)
    const out = await h.call({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
      payload: { refreshToken },
    })
    expect(out.status).toBe(204)
    expect((await h.call({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } })).status).toBe(401)
    expect((await h.call({ method: 'GET', url: '/auth/me', headers: { cookie } })).status).toBe(200)
  })

  it('without any credential it is an idempotent no-op', async () => {
    const { h } = await setup(adapter)
    expect((await h.call({ method: 'POST', url: '/auth/logout' })).status).toBe(204)
  })
})
