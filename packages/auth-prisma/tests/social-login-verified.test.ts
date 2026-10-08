import { describe, expect, it } from 'vitest'
import { Auth, type PasswordHasher } from '@basaltkit/auth'
import { PrismaUserSource } from '../src/index.js'
import { makeFakeClient } from './fake-client.js'

const hasher: PasswordHasher = {
  hash: async (p) => `plain:${p}`,
  verify: async (p, h) => h === `plain:${p}`,
}

/** W13: a first social login creates the account verified and linked, once. */
describe('Auth.socialLogin over PrismaUserSource', () => {
  it('creates a verified, linked account that later logins reach', async () => {
    const users = new PrismaUserSource(makeFakeClient())
    const auth = new Auth({ users, secret: 'x'.repeat(32), hasher })
    const identity = { provider: 'google', subject: 'sub-1' }
    const first = await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })
    expect(first).toMatchObject({ created: true, user: { emailVerified: true } })
    expect((await users.findById(first.user.id))?.emailVerified).toBe(true)
    const again = await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })
    expect(again).toMatchObject({ created: false, user: { id: first.user.id, emailVerified: true } })
  })
})
