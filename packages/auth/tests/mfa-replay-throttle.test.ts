import { describe, expect, it } from 'vitest'
import {
  AccountLockedError,
  Auth,
  InvalidCredentialsError,
  LoginThrottle,
  MemoryMfaStore,
  MemoryUserSource,
  totp,
} from '../src/index.js'

const SECRET = 'x'.repeat(32)

describe('TOTP anti-replay (H-2)', () => {
  it('accepts a code once, then rejects the same code (replay) within its window', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, mfa: new MemoryMfaStore() })
    const user = await auth.register('a@b.c', 'password123')

    const { secret } = await auth.enrollMfa(user.id)
    const code = totp(secret)
    await auth.activateMfa(user.id, code)

    // First presentation of the code is accepted and its step is recorded;
    // reusing the same code within its window is refused (replay).
    expect(await auth.verifyMfaCode(user.id, code)).toBe(true)
    expect(await auth.verifyMfaCode(user.id, code)).toBe(false)
  })
})

describe('IP login throttle (M-1)', () => {
  it('locks by IP after a spray across many accounts, leaving other IPs unaffected', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret: SECRET,
      loginThrottle: false, // isolate the IP dimension
      ipLoginThrottle: new LoginThrottle({ maxAttempts: 3, windowMs: 60_000 }),
    })

    // Three failures from one IP, each a different (non-existent) account.
    for (let i = 0; i < 3; i++) {
      await expect(auth.login(`u${i}@x.c`, 'wrong', undefined, { ip: '1.2.3.4' })).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      )
    }
    // The IP is now locked — even a new account attempt is refused up front.
    await expect(auth.login('u9@x.c', 'wrong', undefined, { ip: '1.2.3.4' })).rejects.toBeInstanceOf(
      AccountLockedError,
    )
    // A different IP still gets normal treatment.
    await expect(auth.login('u9@x.c', 'wrong', undefined, { ip: '9.9.9.9' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    )
  })
})
