import { describe, expect, it } from 'vitest'
import {
  Auth,
  EmailTakenError,
  InvalidCredentialsError,
  MemoryUserSource,
  RefreshInvalidError,
  RefreshReusedError,
  ScryptPasswordHasher,
  signJwt,
  TokenExpiredError,
  TokenInvalidError,
  verifyJwt,
} from '../src/index.js'

describe('ScryptPasswordHasher', () => {
  it('round-trips and rejects wrong passwords and tampered hashes', async () => {
    const hasher = new ScryptPasswordHasher()
    const hash = await hasher.hash('correct horse battery staple')
    expect(await hasher.verify('correct horse battery staple', hash)).toBe(true)
    expect(await hasher.verify('wrong', hash)).toBe(false)
    expect(await hasher.verify('correct horse battery staple', hash.slice(0, -2))).toBe(false)
    expect(await hasher.verify('anything', 'not-a-hash')).toBe(false)
  })
})

describe('JWT (HS256)', () => {
  it('signs and verifies claims', () => {
    const token = signJwt({ sub: 'u1', role: 'admin' }, { secret: 's3cret', expiresIn: '1h' })
    const claims = verifyJwt(token, 's3cret')
    expect(claims.sub).toBe('u1')
    expect(claims['role']).toBe('admin')
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('rejects bad signatures, malformed tokens and expired tokens', () => {
    const token = signJwt({ sub: 'u1' }, { secret: 's3cret', expiresIn: '1h' })
    expect(() => verifyJwt(token, 'other-secret')).toThrowError(TokenInvalidError)
    expect(() => verifyJwt('abc.def', 's3cret')).toThrowError(TokenInvalidError)
    const expired = signJwt({ sub: 'u1' }, { secret: 's3cret', expiresIn: 0 })
    expect(() => verifyJwt(expired, 's3cret')).toThrowError(TokenExpiredError)
  })
})

const makeAuth = () =>
  new Auth({ users: new MemoryUserSource(), secret: 'test-secret', accessTtl: '15m' })

describe('Auth', () => {
  it('register + login issues verifiable tokens; duplicate email is 409', async () => {
    const auth = makeAuth()
    const user = await auth.register('ada@example.com', 'password123')
    expect(user).toEqual({ id: user.id, email: 'ada@example.com' })
    await expect(auth.register('ada@example.com', 'x'.repeat(10))).rejects.toBeInstanceOf(
      EmailTakenError,
    )

    const { tokens } = await auth.login('ada@example.com', 'password123')
    expect(auth.verifyAccess(tokens.accessToken).sub).toBe(user.id)
    await expect(auth.login('ada@example.com', 'wrong-password')).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    )
  })

  it('refresh rotation: old token is consumed, reuse revokes the family', async () => {
    const auth = makeAuth()
    await auth.register('ada@example.com', 'password123')
    const { tokens: first } = await auth.login('ada@example.com', 'password123')

    const second = await auth.refresh(first.refreshToken)
    expect(second.refreshToken).not.toBe(first.refreshToken)

    // replaying the consumed token = theft indicator → family revoked
    await expect(auth.refresh(first.refreshToken)).rejects.toBeInstanceOf(RefreshReusedError)
    // the fresh token of the same family is now dead too
    await expect(auth.refresh(second.refreshToken)).rejects.toBeInstanceOf(RefreshInvalidError)
  })

  it('sessions: create, resolve user, logout', async () => {
    const auth = makeAuth()
    const user = await auth.register('ada@example.com', 'password123')
    const session = await auth.createSession(user.id)
    expect((await auth.sessionUser(session.id))?.email).toBe('ada@example.com')
    await auth.logout(session.id)
    expect(await auth.sessionUser(session.id)).toBeNull()
  })

  it('revoke() kills a refresh family — token-client logout', async () => {
    const auth = makeAuth()
    await auth.register('ada@example.com', 'password123')
    const { tokens } = await auth.login('ada@example.com', 'password123')
    await auth.revoke(tokens.refreshToken)
    await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(RefreshInvalidError)
  })
})
