import { describe, expect, it } from 'vitest'
import { Auth, EmailTakenError, MemoryUserSource } from '../src/index.js'

const SECRET = 'x'.repeat(32)

describe('enumeration-safe registration (M-2)', () => {
  it('registerSafely does not reveal an existing email and never mutates the account', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    await auth.register('a@b.c', 'password123') // an existing account

    // Re-registering an existing email with a DIFFERENT password neither throws
    // nor changes anything — the response can't reveal the account exists.
    await expect(auth.registerSafely('a@b.c', 'a-different-password')).resolves.toBeUndefined()

    // The original account is untouched: old password works, the new one doesn't.
    expect((await auth.login('a@b.c', 'password123')).tokens.accessToken).toBeTruthy()
    await expect(auth.login('a@b.c', 'a-different-password')).rejects.toBeTruthy()

    // A brand-new email registers normally.
    await auth.registerSafely('new@b.c', 'password123')
    expect((await auth.login('new@b.c', 'password123')).tokens.accessToken).toBeTruthy()
  })

  it('with enumerationSafeRegister:false it throws on a duplicate (classic behavior)', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, enumerationSafeRegister: false })
    await auth.register('a@b.c', 'password123')
    await expect(auth.registerSafely('a@b.c', 'password123')).rejects.toBeInstanceOf(EmailTakenError)
  })

  it('the low-level register() still throws on a duplicate for programmatic callers', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    await auth.register('a@b.c', 'password123')
    await expect(auth.register('a@b.c', 'password123')).rejects.toBeInstanceOf(EmailTakenError)
  })
})
