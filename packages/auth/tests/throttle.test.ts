import { describe, expect, it } from 'vitest'
import { AccountLockedError, Auth, InvalidCredentialsError, LoginThrottle, MemoryUserSource } from '../src/index.js'

async function seededAuth(throttle?: LoginThrottle | false) {
  const users = new MemoryUserSource()
  const auth = new Auth({ users, secret: 'test-secret-value-123456', ...(throttle !== undefined ? { loginThrottle: throttle } : {}) })
  await auth.register('user@example.com', 'correct-horse-battery')
  return auth
}

describe('LoginThrottle', () => {
  it('locks after too many failures and clears on success', async () => {
    let now = 0
    const throttle = new LoginThrottle({ maxAttempts: 3, windowMs: 60_000, clock: () => now })
    const auth = await seededAuth(throttle)

    // 3 wrong attempts → InvalidCredentials each
    for (let i = 0; i < 3; i++) {
      await expect(auth.login('user@example.com', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError)
    }
    // 4th → locked, even with the RIGHT password
    await expect(auth.login('user@example.com', 'correct-horse-battery')).rejects.toBeInstanceOf(AccountLockedError)

    // window rolls over → allowed again, correct password works and resets
    now += 60_001
    const { tokens } = await auth.login('user@example.com', 'correct-horse-battery')
    expect(tokens.accessToken).toBeTruthy()

    // counter cleared: a fresh wrong attempt does not immediately lock
    await expect(auth.login('user@example.com', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError)
  })

  it('is keyed case-insensitively by email', async () => {
    const now = 0
    const throttle = new LoginThrottle({ maxAttempts: 2, windowMs: 60_000, clock: () => now })
    const auth = await seededAuth(throttle)
    await expect(auth.login('USER@example.com', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError)
    await expect(auth.login('user@EXAMPLE.com', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError)
    await expect(auth.login('User@Example.com', 'correct-horse-battery')).rejects.toBeInstanceOf(AccountLockedError)
  })

  it('can be disabled with loginThrottle: false', async () => {
    const auth = await seededAuth(false)
    for (let i = 0; i < 10; i++) {
      await expect(auth.login('user@example.com', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError)
    }
    // never locks — still InvalidCredentials, not AccountLocked
    await expect(auth.login('user@example.com', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError)
  })

  it('is on by default', async () => {
    const auth = await seededAuth() // no throttle passed → default enabled
    for (let i = 0; i < 5; i++) {
      await auth.login('user@example.com', 'wrong').catch(() => {})
    }
    await expect(auth.login('user@example.com', 'correct-horse-battery')).rejects.toBeInstanceOf(AccountLockedError)
  })
})
