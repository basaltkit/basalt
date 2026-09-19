import { afterEach, describe, expect, it } from 'vitest'
import { ctx } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { MemoryUserSource, authPlugin, authRoutes, mfaRoutes, totp, type AuthPluginOptions } from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/**
 * BK-007: MFA required by policy. `requireMfa` makes every authenticated route
 * refuse a credential that was not obtained with a second factor, except the
 * account routes needed to enrol and sign in again; `meta.mfa: true` asks for
 * it on a single route (step-up). Tokens and sessions carry `amr`.
 */

const secret = 'test-secret-test-secret-test-secret'
const password = 'password123'
const routes = [
  ...authRoutes({ rateLimit: false }),
  ...mfaRoutes(),
  route({ method: 'GET', url: '/data', meta: { auth: true }, handler: () => ({ amr: ctx().amr ?? null }) }),
  route({ method: 'POST', url: '/wire', meta: { auth: true, mfa: true }, handler: () => ({ ok: true }) }),
]

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
const cookieOf = (res: { headers: Record<string, string | string[] | undefined> }) => {
  const setCookie = res.headers['set-cookie']
  return String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

async function setup(adapter: (typeof availableAdapters)[number], extra: Partial<AuthPluginOptions> = {}) {
  harness = await boot(
    adapter,
    [authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher, ...extra })],
    routes,
  )
  const h = harness
  const register = async (email: string) => {
    await h.call({ method: 'POST', url: '/auth/register', payload: { email, password } })
  }
  const login = (email: string, mfaCode?: string) =>
    h.call({ method: 'POST', url: '/auth/login', payload: { email, password, ...(mfaCode ? { mfaCode } : {}) } })
  /** Enrols + activates TOTP through the HTTP routes; returns the secret and recovery codes. */
  const enrol = async (access: string) => {
    const enrolled = await h.call({ method: 'POST', url: '/auth/mfa/enroll', headers: bearer(access) })
    expect(enrolled.status).toBe(200)
    const totpSecret = enrolled.body.secret as string
    const activated = await h.call({
      method: 'POST',
      url: '/auth/mfa/activate',
      headers: bearer(access),
      payload: { code: totp(totpSecret) },
    })
    expect(activated.status).toBe(200)
    return { totpSecret, recoveryCodes: activated.body.recoveryCodes as string[] }
  }
  return { h, register, login, enrol }
}

describe.each(availableAdapters)('requireMfa policy (%s)', (adapter) => {
  it('is off by default: a password-only login reaches every route', async () => {
    const { h, register, login } = await setup(adapter)
    await register('a@acme.test')
    const res = await login('a@acme.test')
    expect(decode(res.body.accessToken).amr).toEqual(['pwd'])
    const data = await h.call({ method: 'GET', url: '/data', headers: bearer(res.body.accessToken) })
    expect(data.status).toBe(200)
    expect(data.body.amr).toEqual(['pwd'])
  })

  it('refuses an unenrolled user everywhere but the account routes, then admits them after an MFA login', async () => {
    const { h, register, login, enrol } = await setup(adapter, { requireMfa: true })
    await register('a@acme.test')
    const first = await login('a@acme.test')
    expect(first.status).toBe(200)
    const access = first.body.accessToken as string

    const refused = await h.call({ method: 'GET', url: '/data', headers: bearer(access) })
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('AUTH_MFA_ENROLLMENT_REQUIRED')
    // The account routes needed to get out of this state stay reachable.
    expect((await h.call({ method: 'GET', url: '/auth/me', headers: bearer(access) })).status).toBe(200)
    expect((await h.call({ method: 'GET', url: '/auth/mfa/status', headers: bearer(access) })).status).toBe(200)

    const { totpSecret, recoveryCodes } = await enrol(access)
    // Enrolled, but this credential was still obtained without a second factor.
    const stepUp = await h.call({ method: 'GET', url: '/data', headers: bearer(access) })
    expect(stepUp.status).toBe(403)
    expect(stepUp.body.error.code).toBe('AUTH_MFA_REQUIRED')

    // Signing in again with a code yields an MFA credential: bearer AND cookie.
    const second = await login('a@acme.test', recoveryCodes[0]!)
    expect(second.status).toBe(200)
    expect(decode(second.body.accessToken).amr).toEqual(['pwd', 'mfa'])
    const viaBearer = await h.call({ method: 'GET', url: '/data', headers: bearer(second.body.accessToken) })
    expect(viaBearer.status).toBe(200)
    expect(viaBearer.body.amr).toEqual(['pwd', 'mfa'])
    const viaCookie = await h.call({ method: 'GET', url: '/data', headers: { cookie: cookieOf(second) } })
    expect(viaCookie.status).toBe(200)

    // Refresh keeps the authentication methods of the original login.
    const refreshed = await h.call({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: second.body.refreshToken } })
    expect(refreshed.status).toBe(200)
    expect(decode(refreshed.body.accessToken).amr).toEqual(['pwd', 'mfa'])
    expect((await h.call({ method: 'GET', url: '/data', headers: bearer(refreshed.body.accessToken) })).status).toBe(200)

    // A password-only refresh family stays password-only.
    const pwdRefresh = await h.call({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: first.body.refreshToken } })
    expect(decode(pwdRefresh.body.accessToken).amr).toEqual(['pwd'])
    expect(totpSecret).toBeTruthy()
  })

  it('a forged MFA marker on a password-only session cookie is not a session', async () => {
    const { h, register, login } = await setup(adapter, { requireMfa: true })
    await register('a@acme.test')
    const res = await login('a@acme.test')
    const cookie = cookieOf(res)
    const [name, value] = cookie.split('=') as [string, string]
    const forged = `${name}=${value}.pwd+mfa.${'A'.repeat(43)}`
    expect((await h.call({ method: 'GET', url: '/data', headers: { cookie: forged } })).status).toBe(401)
    // The genuine cookie is authenticated — but refused by the policy.
    const genuine = await h.call({ method: 'GET', url: '/data', headers: { cookie } })
    expect(genuine.status).toBe(403)
  })

  it('a policy function decides per user', async () => {
    const { h, register, login } = await setup(adapter, {
      requireMfa: (user) => user.email.endsWith('@admin.test'),
    })
    await register('staff@acme.test')
    await register('root@admin.test')
    const staff = await login('staff@acme.test')
    const root = await login('root@admin.test')
    expect((await h.call({ method: 'GET', url: '/data', headers: bearer(staff.body.accessToken) })).status).toBe(200)
    const refused = await h.call({ method: 'GET', url: '/data', headers: bearer(root.body.accessToken) })
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('AUTH_MFA_ENROLLMENT_REQUIRED')
  })

  it('meta.mfa: true asks for MFA on one route even without a policy (step-up)', async () => {
    const { h, register, login, enrol } = await setup(adapter)
    await register('a@acme.test')
    const pwd = await login('a@acme.test')
    const refused = await h.call({ method: 'POST', url: '/wire', headers: bearer(pwd.body.accessToken) })
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('AUTH_MFA_ENROLLMENT_REQUIRED')
    // Other routes are unaffected without a policy.
    expect((await h.call({ method: 'GET', url: '/data', headers: bearer(pwd.body.accessToken) })).status).toBe(200)

    const { recoveryCodes } = await enrol(pwd.body.accessToken)
    const mfa = await login('a@acme.test', recoveryCodes[0]!)
    expect((await h.call({ method: 'POST', url: '/wire', headers: bearer(mfa.body.accessToken) })).status).toBe(200)
  })
})
