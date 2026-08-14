import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import {
  Auth,
  AuthTokenInvalidError,
  authPlugin,
  authRoutes,
  InvalidCredentialsError,
  MemoryAuthTokenStore,
  MemorySessionStore,
  MemoryUserSource,
  RefreshInvalidError,
} from '../src/index.js'
import { createHash } from 'node:crypto'

const secret = 'test-secret-value-123456'
const json = (res: { json(): unknown }): any => res.json()

describe('email verification', () => {
  it('verifies via a single-use token and flips emailVerified', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret })
    const user = await auth.register('ada@acme.test', 'password123')
    expect(user.emailVerified).toBe(false)

    const requested = await auth.requestEmailVerification('ada@acme.test')
    expect(requested).not.toBeNull()

    const verified = await auth.verifyEmail(requested!.token)
    expect(verified.emailVerified).toBe(true)

    // single-use
    await expect(auth.verifyEmail(requested!.token)).rejects.toBeInstanceOf(AuthTokenInvalidError)
  })

  it('does not reveal whether an email exists, and rejects garbage tokens', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret })
    expect(await auth.requestEmailVerification('nobody@x.com')).toBeNull()
    await expect(auth.verifyEmail('garbage')).rejects.toBeInstanceOf(AuthTokenInvalidError)
  })

  it('a reset token cannot be used to verify email (purpose is checked)', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret })
    await auth.register('ada@acme.test', 'password123')
    const reset = await auth.requestPasswordReset('ada@acme.test')
    await expect(auth.verifyEmail(reset!.token)).rejects.toBeInstanceOf(AuthTokenInvalidError)
  })
})

describe('password reset', () => {
  it('resets the password and revokes existing sessions', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret, loginThrottle: false })
    await auth.register('ada@acme.test', 'old-password-1')
    const { tokens } = await auth.login('ada@acme.test', 'old-password-1')

    const requested = await auth.requestPasswordReset('ada@acme.test')
    await auth.resetPassword(requested!.token, 'new-password-2')

    // old password no longer works; new one does
    await expect(auth.login('ada@acme.test', 'old-password-1')).rejects.toBeInstanceOf(InvalidCredentialsError)
    expect((await auth.login('ada@acme.test', 'new-password-2')).tokens.accessToken).toBeTruthy()

    // the pre-reset refresh token was revoked
    await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(RefreshInvalidError)

    // reset token is single-use
    await expect(auth.resetPassword(requested!.token, 'again-1234')).rejects.toBeInstanceOf(AuthTokenInvalidError)
  })

  it('a reset invalidates active server-side sessions too, not just refresh tokens', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret, loginThrottle: false })
    const user = await auth.register('ada@acme.test', 'old-password-1')
    const session = await auth.createSession(user.id)
    expect(await auth.sessionUser(session.id)).not.toBeNull()

    const requested = await auth.requestPasswordReset('ada@acme.test')
    await auth.resetPassword(requested!.token, 'new-password-2')

    // the cookie session minted before the reset is gone
    expect(await auth.sessionUser(session.id)).toBeNull()
  })

  it('persists only the hash of a one-time token, never the raw value', async () => {
    const tokens = new MemoryAuthTokenStore()
    const auth = new Auth({ users: new MemoryUserSource(), secret, tokens })
    await auth.register('ada@acme.test', 'password123')

    const requested = await auth.requestPasswordReset('ada@acme.test')
    const raw = requested!.token
    const expectedHash = createHash('sha256').update(raw).digest('hex')

    // the raw token is not a key in the store; its sha256 is
    expect(await tokens.find(raw)).toBeNull()
    expect(await tokens.find(expectedHash)).not.toBeNull()

    // and the raw token still resolves the reset (lookup hashes on the way in)
    const reset = await auth.resetPassword(raw, 'new-password-2')
    expect(reset.email).toBe('ada@acme.test')
  })
})

describe('login timing (account enumeration)', () => {
  it('attempt() returns null for an unknown email without leaking existence', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret, sessions: new MemorySessionStore() })
    // Both a missing account and a wrong password resolve to null (the timing
    // path runs a dummy verify for the missing case — see attempt()).
    expect(await auth.attempt('nobody@x.com', 'whatever-123')).toBeNull()
    await auth.register('ada@acme.test', 'password123')
    expect(await auth.attempt('ada@acme.test', 'wrong-password')).toBeNull()
    expect(await auth.attempt('ada@acme.test', 'password123')).not.toBeNull()
  })
})

describe('HTTP routes', () => {
  it('password reset works end to end over HTTP (no account enumeration)', async () => {
    const app = await createApp({
      plugins: [authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }), fastifyPlugin({ routes: authRoutes() })],
    }).boot()
    const server = app.container.get(FASTIFY)

    let resetToken = ''
    app.hooks.on('auth:password_reset_requested', (payload) => {
      resetToken = (payload as { token: string }).token
    })

    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'ada@acme.test', password: 'old-password-1' } })

    // forgot: 200 for a real account AND an unknown one
    expect((await server.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'ada@acme.test' } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'nobody@x.com' } })).statusCode).toBe(200)
    expect(resetToken).toBeTruthy()

    const reset = await server.inject({ method: 'POST', url: '/auth/password/reset', payload: { token: resetToken, password: 'new-password-2' } })
    expect(reset.statusCode).toBe(200)
    expect(json(reset).ok).toBe(true)

    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ada@acme.test', password: 'new-password-2' } })
    expect(login.statusCode).toBe(200)
    await app.shutdown()
  })

  it('email verification works end to end over HTTP', async () => {
    const app = await createApp({
      plugins: [authPlugin({ users: new MemoryUserSource(), secret }), fastifyPlugin({ routes: authRoutes() })],
    }).boot()
    const server = app.container.get(FASTIFY)

    let verifyToken = ''
    app.hooks.on('auth:verify_requested', (payload) => {
      verifyToken = (payload as { token: string }).token
    })

    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'ada@acme.test', password: 'password123' } })
    expect((await server.inject({ method: 'POST', url: '/auth/verify/request', payload: { email: 'ada@acme.test' } })).statusCode).toBe(200)
    expect(verifyToken).toBeTruthy()

    const verify = await server.inject({ method: 'POST', url: '/auth/verify', payload: { token: verifyToken } })
    expect(verify.statusCode).toBe(200)
    expect(json(verify).user.emailVerified).toBe(true)
    await app.shutdown()
  })
})
