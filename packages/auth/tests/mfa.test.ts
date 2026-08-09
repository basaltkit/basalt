import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import {
  Auth,
  InvalidCredentialsError,
  MemoryUserSource,
  MfaInvalidCodeError,
  MfaNotEnrolledError,
  MfaRequiredError,
  authPlugin,
  authRoutes,
  mfaRoutes,
  totp,
} from '../src/index.js'

const secret = 'test-secret-value-123456'

async function enrolledAuth() {
  const auth = new Auth({ users: new MemoryUserSource(), secret, loginThrottle: false })
  const user = await auth.register('ada@acme.test', 'password123')
  const { secret: totpSecret } = await auth.enrollMfa(user.id)
  const { recoveryCodes } = await auth.activateMfa(user.id, totp(totpSecret))
  return { auth, userId: user.id, totpSecret, recoveryCodes }
}

describe('MFA login flow', () => {
  it('enrollment is pending until activated', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret, loginThrottle: false })
    const user = await auth.register('ada@acme.test', 'password123')
    await auth.enrollMfa(user.id)
    // still pending — login needs no code yet
    expect(await auth.isMfaEnabled(user.id)).toBe(false)
    expect((await auth.login('ada@acme.test', 'password123')).tokens.accessToken).toBeTruthy()

    // wrong code fails activation, right code enables it
    await expect(auth.activateMfa(user.id, '000000')).rejects.toBeInstanceOf(MfaInvalidCodeError)
  })

  it('requires a valid TOTP code once enabled', async () => {
    const { auth, totpSecret } = await enrolledAuth()

    await expect(auth.login('ada@acme.test', 'password123')).rejects.toBeInstanceOf(MfaRequiredError)
    await expect(auth.login('ada@acme.test', 'password123', '000000')).rejects.toBeInstanceOf(MfaInvalidCodeError)
    // a wrong password is still a credentials error, not an MFA one
    await expect(auth.login('ada@acme.test', 'wrong-password')).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect((await auth.login('ada@acme.test', 'password123', totp(totpSecret))).tokens.accessToken).toBeTruthy()
  })

  it('accepts a single-use recovery code', async () => {
    const { auth, recoveryCodes } = await enrolledAuth()
    expect(recoveryCodes).toHaveLength(10)

    const code = recoveryCodes[0]!
    expect((await auth.login('ada@acme.test', 'password123', code)).tokens.accessToken).toBeTruthy()
    // consumed — cannot be reused
    await expect(auth.login('ada@acme.test', 'password123', code)).rejects.toBeInstanceOf(MfaInvalidCodeError)
  })

  it('disables MFA with a valid code', async () => {
    const { auth, userId, totpSecret } = await enrolledAuth()
    await expect(auth.disableMfa(userId, '000000')).rejects.toBeInstanceOf(MfaInvalidCodeError)
    await auth.disableMfa(userId, totp(totpSecret))
    expect(await auth.isMfaEnabled(userId)).toBe(false)
    await expect(auth.disableMfa(userId, totp(totpSecret))).rejects.toBeInstanceOf(MfaNotEnrolledError)
    expect((await auth.login('ada@acme.test', 'password123')).tokens.accessToken).toBeTruthy()
  })
})

describe('MFA HTTP flow', () => {
  it('enrolls, activates, and challenges at login', async () => {
    const app = await createApp({
      plugins: [
        authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
        fastifyPlugin({ routes: [...authRoutes(), ...mfaRoutes()] }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)

    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'ada@acme.test', password: 'password123' } })
    const access = (await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@acme.test', password: 'password123' } })).json().accessToken
    const authz = { authorization: `Bearer ${access}` }

    const enroll = await server.inject({ method: 'POST', url: '/auth/mfa/enroll', headers: authz })
    const totpSecret = enroll.json().secret as string
    expect(enroll.json().otpauthUri).toContain('otpauth://totp/')

    const activate = await server.inject({ method: 'POST', url: '/auth/mfa/activate', headers: authz, payload: { code: totp(totpSecret) } })
    expect(activate.statusCode).toBe(200)
    expect((activate.json().recoveryCodes as string[]).length).toBe(10)

    // login now requires a code
    const challenged = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@acme.test', password: 'password123' } })
    expect(challenged.statusCode).toBe(401)
    expect(challenged.json().error?.code ?? challenged.json().code).toBe('AUTH_MFA_REQUIRED')

    const ok = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@acme.test', password: 'password123', mfaCode: totp(totpSecret) } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().accessToken).toBeTruthy()

    const status = await server.inject({ method: 'GET', url: '/auth/mfa/status', headers: { authorization: `Bearer ${ok.json().accessToken}` } })
    expect(status.json().enabled).toBe(true)

    await app.shutdown()
  })
})
