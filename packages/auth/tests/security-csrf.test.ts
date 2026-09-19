import { afterEach, describe, expect, it } from 'vitest'
import { ctx } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { MemoryUserSource, authPlugin, authRoutes, type AuthPluginOptions } from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/**
 * Cookie-session requests with an unsafe method must come from the app's own
 * origin (F31). Bearer / x-session-id credentials are not ambient, so they are
 * not subject to the check.
 */

const secret = 'test-secret-test-secret-test-secret'
const routes = [
  ...authRoutes({ rateLimit: false }),
  route({ method: 'POST', url: '/transfer', meta: { auth: true }, handler: () => ({ by: ctx().user?.id }) }),
  route({ method: 'GET', url: '/profile', meta: { auth: true }, handler: () => ({ by: ctx().user?.id }) }),
]

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(adapter: (typeof availableAdapters)[number], extra: Partial<AuthPluginOptions> = {}) {
  harness = await boot(adapter, [authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher, ...extra })], routes)
  const h = harness
  await h.call({ method: 'POST', url: '/auth/register', payload: { email: 'v@acme.test', password: 'password123' } })
  const login = await h.call({ method: 'POST', url: '/auth/login', payload: { email: 'v@acme.test', password: 'password123' } })
  const setCookie = login.headers['set-cookie']
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!
  return { h, cookie, access: login.body.accessToken as string }
}

describe.each(availableAdapters)('CSRF defence for cookie sessions (%s)', (adapter) => {
  it('refuses a cross-site unsafe request carrying only the session cookie', async () => {
    const { h, cookie } = await setup(adapter)
    const crossOrigin = await h.call({ method: 'POST', url: '/transfer', headers: { cookie, origin: 'https://evil.example' } })
    expect(crossOrigin.status).toBe(403)
    expect(crossOrigin.body.error.code).toBe('AUTH_CSRF_REJECTED')

    const crossSite = await h.call({ method: 'POST', url: '/transfer', headers: { cookie, 'sec-fetch-site': 'cross-site' } })
    expect(crossSite.status).toBe(403)

    // A sibling subdomain is "same-site" — SameSite=Lax does not stop it.
    const sibling = await h.call({ method: 'POST', url: '/transfer', headers: { cookie, 'sec-fetch-site': 'same-site', origin: 'https://evil.acme.test' } })
    expect(sibling.status).toBe(403)
  })

  it('allows same-origin requests, safe methods, and non-ambient credentials', async () => {
    const { h, cookie, access } = await setup(adapter)
    const sameOrigin = await h.call({
      method: 'POST',
      url: '/transfer',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(sameOrigin.status).toBe(200)
    // Behind a proxy that rewrites Host, the browser's own same-origin marker wins.
    const proxied = await h.call({
      method: 'POST',
      url: '/transfer',
      headers: { cookie, 'sec-fetch-site': 'same-origin', origin: 'https://public.acme.test' },
    })
    expect(proxied.status).toBe(200)
    // An Origin matching the request's own host is same-origin.
    const ownHost = await h.call({ method: 'POST', url: '/transfer', headers: { cookie, origin: 'https://own.acme.test', 'x-forwarded-host': 'own.acme.test' } })
    expect(ownHost.status).toBe(200)
    // `Origin: null` (sandboxed iframe, data: URL) is refused.
    expect((await h.call({ method: 'POST', url: '/transfer', headers: { cookie, origin: 'null' } })).status).toBe(403)

    // No browser metadata at all (curl, server-to-server): allowed.
    expect((await h.call({ method: 'POST', url: '/transfer', headers: { cookie } })).status).toBe(200)
    // Safe method cross-site: allowed (no state change).
    expect((await h.call({ method: 'GET', url: '/profile', headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(200)
    // Bearer is not ambient — CSRF does not apply.
    expect(
      (await h.call({ method: 'POST', url: '/transfer', headers: { authorization: `Bearer ${access}`, origin: 'https://evil.example' } })).status,
    ).toBe(200)
  })

  it('trustedOrigins admits a known front-end origin; csrf: false opts out', async () => {
    const trusted = await setup(adapter, { csrf: { trustedOrigins: ['https://app.acme.test'] } })
    expect(
      (await trusted.h.call({ method: 'POST', url: '/transfer', headers: { cookie: trusted.cookie, origin: 'https://app.acme.test', 'sec-fetch-site': 'same-site' } })).status,
    ).toBe(200)
    await trusted.h.close()
    harness = undefined

    const off = await setup(adapter, { csrf: false })
    expect((await off.h.call({ method: 'POST', url: '/transfer', headers: { cookie: off.cookie, origin: 'https://evil.example' } })).status).toBe(200)
  })
})
