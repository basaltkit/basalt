import { Auth, totp } from '@basaltkit/auth'
import { describe, expect, it } from 'vitest'
import { sqliteAuthStores } from '../src/index.js'

const secret = 'test-secret-test-secret-test-secret'
const hasher = {
  hash: async (p: string) => `plain:${p}`,
  verify: async (p: string, h: string) => h === `plain:${p}`,
}

async function mfaUser() {
  const s = sqliteAuthStores(':memory:')
  const auth = new Auth({ secret, users: s.users, mfa: s.mfa, hasher, loginThrottle: false, ipLoginThrottle: false })
  const user = await auth.register('ada@acme.test', 'password123')
  const { secret: totpSecret } = await auth.enrollMfa(user.id)
  const { recoveryCodes } = await auth.activateMfa(user.id, totp(totpSecret))
  return { auth, s, user, totpSecret, recoveryCodes }
}

describe('SqliteMfaStore: single-use codes are consumed atomically (F19)', () => {
  it('the same TOTP code verified concurrently is accepted exactly once', async () => {
    const { auth, user, totpSecret } = await mfaUser()
    const code = totp(totpSecret)
    const results = await Promise.all([auth.verifyMfaCode(user.id, code), auth.verifyMfaCode(user.id, code)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('the same recovery code verified concurrently is accepted exactly once', async () => {
    const { auth, user, recoveryCodes } = await mfaUser()
    const code = recoveryCodes[0]!
    const results = await Promise.all([
      auth.verifyMfaCode(user.id, code),
      auth.verifyMfaCode(user.id, code),
      auth.verifyMfaCode(user.id, code),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('consumeTotpStep / consumeRecoveryCode are conditional updates', async () => {
    const { s, user } = await mfaUser()
    expect(await s.mfa.consumeTotpStep(user.id, 100)).toBe(true)
    expect(await s.mfa.consumeTotpStep(user.id, 100)).toBe(false)
    expect(await s.mfa.consumeTotpStep(user.id, 99)).toBe(false)
    expect(await s.mfa.consumeTotpStep(user.id, 101)).toBe(true)
    const [hash] = (await s.mfa.get(user.id))!.recoveryCodes
    expect(await s.mfa.consumeRecoveryCode(user.id, hash!)).toBe(true)
    expect(await s.mfa.consumeRecoveryCode(user.id, hash!)).toBe(false)
    expect(await s.mfa.consumeTotpStep('nobody', 1)).toBe(false)
  })
})

describe('SqliteUserSource: emails are case-insensitive identities (F25)', () => {
  it('finds a user whatever the case, and a case variant cannot register again', async () => {
    const s = sqliteAuthStores(':memory:')
    const created = await s.users.create({ email: 'Legacy@Acme.test', passwordHash: 'x' })
    expect((await s.users.findByEmail('legacy@acme.test'))?.id).toBe(created.id)
    await expect(s.users.create({ email: 'LEGACY@acme.test', passwordHash: 'y' })).rejects.toThrow()

    const auth = new Auth({ secret, users: s.users, hasher, loginThrottle: false, enumerationSafeRegister: false })
    await auth.register('bob@acme.test', 'password123')
    await expect(auth.register('BOB@acme.test', 'password456')).rejects.toMatchObject({ code: 'AUTH_EMAIL_TAKEN' })
  })
})
