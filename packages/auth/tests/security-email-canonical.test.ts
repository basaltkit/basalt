import { describe, expect, it } from 'vitest'
import { Auth, EmailTakenError, MemoryUserSource } from '../src/index.js'
import { fastHasher } from './helpers/adapters.js'

const secret = 'x'.repeat(32)

describe('emails are case-insensitive identities (F25)', () => {
  it('a case variant of a registered email cannot create a second account', async () => {
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret, hasher: fastHasher, loginThrottle: false, enumerationSafeRegister: false })
    const bob = await auth.register('bob@acme.test', 'password123')

    await expect(auth.register('BOB@acme.test', 'password456')).rejects.toBeInstanceOf(EmailTakenError)
    await expect(auth.register('  Bob@Acme.Test ', 'password456')).rejects.toBeInstanceOf(EmailTakenError)
    await expect(auth.registerSafely('BOB@ACME.TEST', 'password456')).rejects.toBeInstanceOf(EmailTakenError)

    // The canonical identity is used for login, reset and verification.
    expect((await auth.login('BOB@Acme.test', 'password123')).user.id).toBe(bob.id)
    expect((await auth.requestPasswordReset('Bob@ACME.test'))?.user.id).toBe(bob.id)
    expect((await auth.requestEmailVerification('bob@ACME.test'))?.user.id).toBe(bob.id)
    expect((await auth.socialLogin('BOB@acme.test', { emailVerified: true, mfa: 'skip' })).user.id).toBe(bob.id)
  })

  it('stores the canonical (trimmed, lowercased) email', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret, hasher: fastHasher, loginThrottle: false })
    await auth.registerSafely('  Carol@Acme.TEST ', 'password123')
    expect((await auth.users.findByEmail('carol@acme.test'))?.email).toBe('carol@acme.test')
  })

  it('MemoryUserSource matches legacy mixed-case rows case-insensitively', async () => {
    const users = new MemoryUserSource()
    await users.create({ email: 'Legacy@Acme.test', passwordHash: 'x' })
    expect(await users.findByEmail('legacy@acme.test')).not.toBeNull()
  })
})
