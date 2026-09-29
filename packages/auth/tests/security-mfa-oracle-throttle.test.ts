import { describe, expect, it } from 'vitest'
import { AccountLockedError, Auth, LoginThrottle, MemoryUserSource, MfaRequiredError, totp } from '../src/index.js'
import { fastHasher } from './helpers/adapters.js'

const secret = 'x'.repeat(32)
const ip = { ip: '198.51.100.7' }

/** Registers an MFA-enabled account; returns its single-use recovery codes. */
async function mfaUser(auth: Auth, email: string, password = 'pw-correct-1'): Promise<string[]> {
  const user = await auth.register(email, password)
  const { secret: s } = await auth.enrollMfa(user.id)
  const { recoveryCodes } = await auth.activateMfa(user.id, totp(s))
  return recoveryCodes
}

/**
 * `AUTH_MFA_REQUIRED` is only returned for a correct password, so it is a
 * password oracle on MFA accounts. Those answers must spend the login budgets
 * like any failed guess — otherwise the oracle allows unthrottled guessing.
 */
describe('AUTH_MFA_REQUIRED counts against the login throttles (audit: password oracle)', () => {
  it('per account: correct-password probes without a code eventually lock the account', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: fastHasher,
      loginThrottle: new LoginThrottle({ maxAttempts: 3 }),
      ipLoginThrottle: false,
    })
    await mfaUser(auth, 'mfa@acme.test')

    for (let i = 0; i < 3; i++) {
      await expect(auth.login('mfa@acme.test', 'pw-correct-1')).rejects.toBeInstanceOf(MfaRequiredError)
    }
    // The budget is spent — the oracle no longer answers.
    await expect(auth.login('mfa@acme.test', 'pw-correct-1')).rejects.toBeInstanceOf(AccountLockedError)
  })

  it('per account: wrong guesses interleaved with the oracle share one budget', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: fastHasher,
      loginThrottle: new LoginThrottle({ maxAttempts: 4 }),
      ipLoginThrottle: false,
    })
    await mfaUser(auth, 'mix@acme.test')

    await expect(auth.login('mix@acme.test', 'guess-1')).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
    await expect(auth.login('mix@acme.test', 'pw-correct-1')).rejects.toBeInstanceOf(MfaRequiredError)
    await expect(auth.login('mix@acme.test', 'guess-2')).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
    await expect(auth.login('mix@acme.test', 'pw-correct-1')).rejects.toBeInstanceOf(MfaRequiredError)
    await expect(auth.login('mix@acme.test', 'guess-3')).rejects.toBeInstanceOf(AccountLockedError)
  })

  it('per IP: probing many MFA accounts from one address spends the IP budget', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: fastHasher,
      loginThrottle: false,
      ipLoginThrottle: new LoginThrottle({ maxAttempts: 3 }),
    })
    for (let i = 0; i < 5; i++) await mfaUser(auth, `u${i}@acme.test`)

    for (let i = 0; i < 3; i++) {
      await expect(auth.login(`u${i}@acme.test`, 'pw-correct-1', undefined, ip)).rejects.toBeInstanceOf(MfaRequiredError)
    }
    await expect(auth.login('u3@acme.test', 'pw-correct-1', undefined, ip)).rejects.toBeInstanceOf(AccountLockedError)
    // Another address is unaffected.
    await expect(auth.login('u3@acme.test', 'pw-correct-1', undefined, { ip: '203.0.113.1' })).rejects.toBeInstanceOf(
      MfaRequiredError,
    )
  })

  it('the legitimate two-step flow never locks the user out (success resets the account counter)', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: fastHasher,
      loginThrottle: new LoginThrottle({ maxAttempts: 2 }),
      ipLoginThrottle: false,
    })
    const codes = await mfaUser(auth, 'legit@acme.test')

    // Recovery codes stand in for fresh TOTP codes (TOTP replay protection
    // refuses the same code twice within its step).
    for (let i = 0; i < 6; i++) {
      await expect(auth.login('legit@acme.test', 'pw-correct-1')).rejects.toBeInstanceOf(MfaRequiredError)
      const { amr } = await auth.login('legit@acme.test', 'pw-correct-1', codes[i])
      expect(amr).toEqual(['pwd', 'mfa'])
    }
  })
})
