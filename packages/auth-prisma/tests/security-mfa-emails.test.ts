import { Auth, MemoryUserSource, totp } from '@basaltkit/auth'
import { describe, expect, it } from 'vitest'
import { PrismaMfaStore, PrismaUserSource, type PrismaAuthClient } from '../src/index.js'
import { makeFakeClient } from './fake-client.js'

const secret = 'test-secret-test-secret-test-secret'
const hasher = {
  hash: async (p: string) => `plain:${p}`,
  verify: async (p: string, h: string) => h === `plain:${p}`,
}

async function mfaUser(client: PrismaAuthClient) {
  const mfa = new PrismaMfaStore(client)
  const auth = new Auth({ secret, users: new MemoryUserSource(), mfa, hasher, loginThrottle: false, ipLoginThrottle: false })
  const user = await auth.register('ada@acme.test', 'password123')
  const { secret: totpSecret } = await auth.enrollMfa(user.id)
  const { recoveryCodes } = await auth.activateMfa(user.id, totp(totpSecret))
  return { auth, mfa, user, totpSecret, recoveryCodes }
}

describe('PrismaMfaStore: single-use codes are consumed atomically (F19)', () => {
  it('the same TOTP code verified concurrently is accepted exactly once', async () => {
    const { auth, user, totpSecret } = await mfaUser(makeFakeClient())
    const code = totp(totpSecret)
    const results = await Promise.all([auth.verifyMfaCode(user.id, code), auth.verifyMfaCode(user.id, code)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('the same recovery code verified concurrently is accepted exactly once', async () => {
    const { auth, user, recoveryCodes } = await mfaUser(makeFakeClient())
    const code = recoveryCodes[0]!
    const results = await Promise.all([
      auth.verifyMfaCode(user.id, code),
      auth.verifyMfaCode(user.id, code),
      auth.verifyMfaCode(user.id, code),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('consumeTotpStep / consumeRecoveryCode are conditional updates', async () => {
    const { mfa, user } = await mfaUser(makeFakeClient())
    expect(await mfa.consumeTotpStep(user.id, 100)).toBe(true)
    expect(await mfa.consumeTotpStep(user.id, 100)).toBe(false)
    expect(await mfa.consumeTotpStep(user.id, 101)).toBe(true)
    const [hash] = (await mfa.get(user.id))!.recoveryCodes
    expect(await mfa.consumeRecoveryCode(user.id, hash!)).toBe(true)
    expect(await mfa.consumeRecoveryCode(user.id, hash!)).toBe(false)
    expect(await mfa.consumeRecoveryCode('nobody', hash!)).toBe(false)
  })
})

describe('PrismaUserSource: emails are case-insensitive identities (F25)', () => {
  it('stores the canonical email and finds legacy mixed-case rows', async () => {
    const client = makeFakeClient()
    const users = new PrismaUserSource(client)
    const created = await users.create({ email: ' Bob@Acme.TEST ', passwordHash: 'x' })
    expect(created.email).toBe('bob@acme.test')
    expect((await users.findByEmail('BOB@acme.test'))?.id).toBe(created.id)

    // A row written before canonicalisation, in mixed case.
    await client.authUser.create({ data: { id: 'legacy', email: 'Legacy@Acme.test', passwordHash: 'x', emailVerified: false } })
    expect((await users.findByEmail('legacy@acme.test'))?.id).toBe('legacy')

    const auth = new Auth({ secret, users, hasher, loginThrottle: false, enumerationSafeRegister: false })
    await expect(auth.register('BOB@acme.test', 'password456')).rejects.toMatchObject({ code: 'AUTH_EMAIL_TAKEN' })
  })
})

describe('PrismaUserSource: the case-insensitive fallback is not a LIKE pattern', () => {
  // On PostgreSQL `{ equals, mode: 'insensitive' }` compiles to `email ILIKE $1`
  // with the value unescaped, so `_` and `%` (both legal in an email address)
  // would match other accounts.
  it('an email containing _ or % never resolves to a different account', async () => {
    const client = makeFakeClient()
    const users = new PrismaUserSource(client)
    const victim = await users.create({ email: 'bob@acme.test', passwordHash: 'x' })
    for (const probe of ['_ob@acme.test', 'b_b@acme.test', '%@acme.test', 'b%@acme.test', '___@acme.test']) {
      expect(await users.findByEmail(probe), probe).toBeNull()
    }
    expect((await users.findByEmail('BOB@acme.test'))?.id).toBe(victim.id)
  })

  it('a legacy mixed-case row whose address contains _ or % is still found', async () => {
    const client = makeFakeClient()
    const users = new PrismaUserSource(client)
    await client.authUser.create({ data: { id: 'legacy', email: 'J_Doe%X@Acme.test', passwordHash: 'x', emailVerified: false } })
    await client.authUser.create({ data: { id: 'other', email: 'JaDoeYYX@Acme.test', passwordHash: 'x', emailVerified: false } })
    expect((await users.findByEmail('j_doe%x@acme.test'))?.id).toBe('legacy')
  })

  it('a provider-verified social login cannot take over an account through a wildcard email', async () => {
    const client = makeFakeClient()
    const users = new PrismaUserSource(client)
    const auth = new Auth({ secret, users, hasher, loginThrottle: false, ipLoginThrottle: false })
    const victim = await auth.register('admin@corp.test', 'password123')
    await users.update(victim.id, { emailVerified: true })
    const { user, created } = await auth.socialLogin('a_min@corp.test', { emailVerified: true })
    expect(created).toBe(true)
    expect(user.id).not.toBe(victim.id)
  })

  it('wildcard variants of an email do not get a fresh login-throttle budget', async () => {
    const client = makeFakeClient()
    const users = new PrismaUserSource(client)
    const auth = new Auth({ secret, users, hasher, ipLoginThrottle: false })
    await auth.register('bob@acme.test', 'password123')
    // `_ob@acme.test` is its own throttle key; it must not reach bob's password check.
    await expect(auth.login('_ob@acme.test', 'password123')).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
  })
})
