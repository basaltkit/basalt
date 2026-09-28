import { describe, expect, it } from 'vitest'
import {
  AccountEmailAmbiguousError,
  AccountLinkConflictError,
  Auth,
  EmailTakenError,
  MemoryWebAuthnChallengeStore,
  PasskeyClonedError,
  WebAuthnService,
  type PasswordHasher,
  type WebAuthnVerifier,
} from '@basaltkit/auth'
import {
  AuthModelMissingError,
  PrismaAccountLinkStore,
  PrismaPasskeyStore,
  PrismaUserSource,
  normalizeAuthUserEmails,
  prismaAuthStores,
} from '../src/index.js'
import { makeFakeClient } from './fake-client.js'

const secret = 'x'.repeat(32)
const hasher: PasswordHasher = { hash: async (p) => `h:${p}`, verify: async (p, h) => h === `h:${p}` }
const legacyRow = (id: string, email: string) => ({ data: { id, email, passwordHash: 'x', emailVerified: false } })

describe('PrismaUserSource: legacy mixed-case emails (FA-070 / D9)', () => {
  it('two rows differing only in case make the lookup ambiguous instead of picking one', async () => {
    const client = makeFakeClient()
    await client.authUser.create(legacyRow('a', 'Bob@Acme.test'))
    await client.authUser.create(legacyRow('b', 'bob@acme.test'))
    const users = new PrismaUserSource(client)
    await expect(users.findByEmail('bob@acme.test')).rejects.toBeInstanceOf(AccountEmailAmbiguousError)
    await expect(users.findByEmail('BOB@acme.test')).rejects.toBeInstanceOf(AccountEmailAmbiguousError)
  })

  it('create refuses a case variant of a legacy row (PostgreSQL @unique is case-sensitive)', async () => {
    const client = makeFakeClient()
    await client.authUser.create(legacyRow('legacy', 'Carol@Acme.test'))
    const users = new PrismaUserSource(client)
    await expect(users.create({ email: 'carol@acme.test', passwordHash: 'y' })).rejects.toBeInstanceOf(EmailTakenError)
  })

  it('a unique violation from a concurrent insert is EmailTakenError', async () => {
    const client = makeFakeClient()
    const users = new PrismaUserSource(client)
    const results = await Promise.allSettled([
      users.create({ email: 'race@acme.test', passwordHash: 'a' }),
      users.create({ email: 'race@acme.test', passwordHash: 'b' }),
    ])
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(EmailTakenError)
  })

  it('normalizeAuthUserEmails rewrites lone mixed-case rows and reports twins', async () => {
    const client = makeFakeClient()
    await client.authUser.create(legacyRow('1', 'Dave@Acme.test'))
    await client.authUser.create(legacyRow('2', 'Eve@Acme.test'))
    await client.authUser.create(legacyRow('3', 'eve@acme.test'))
    await client.authUser.create(legacyRow('4', 'ok@acme.test'))

    const preview = await normalizeAuthUserEmails(client, { dryRun: true, pageSize: 2 })
    expect(preview.normalized).toEqual([{ id: '1', from: 'Dave@Acme.test', to: 'dave@acme.test' }])
    expect(preview.conflicts).toEqual([{ email: 'eve@acme.test', ids: ['2', '3'] }])
    expect((await client.authUser.findUnique({ where: { id: '1' } }))?.email).toBe('Dave@Acme.test')

    const report = await normalizeAuthUserEmails(client, { pageSize: 2 })
    expect(report).toEqual(preview)
    expect((await client.authUser.findUnique({ where: { id: '1' } }))?.email).toBe('dave@acme.test')
    expect((await normalizeAuthUserEmails(client)).normalized).toEqual([])
  })

  it('on MySQL (no insensitive mode) the exact lookup is used and the probe is not retried', async () => {
    const client = makeFakeClient({ provider: 'mysql' }) as ReturnType<typeof makeFakeClient> & { calls: { insensitive: number } }
    await client.authUser.create(legacyRow('m', 'Mixed@Acme.test'))
    const users = new PrismaUserSource(client)
    expect((await users.findByEmail('mixed@acme.test'))?.id).toBe('m')
    expect((await users.findByEmail('MIXED@acme.test'))?.id).toBe('m')
    expect(client.calls.insensitive).toBe(1)
    await expect(users.create({ email: 'mixed@acme.test', passwordHash: 'z' })).rejects.toBeInstanceOf(EmailTakenError)
  })
})

describe('PrismaAccountLinkStore (FA-058)', () => {
  it('links are unique per (provider, subject) and listed per user', async () => {
    const links = new PrismaAccountLinkStore(makeFakeClient())
    const link = { provider: 'google', subject: 's'.repeat(255), userId: 'u1', email: 'a@x.test', createdAt: 1000 }
    expect(await links.create(link)).toBe(true)
    expect(await links.create({ ...link, userId: 'u2' })).toBe(false)
    expect(await links.find('google', 's'.repeat(255))).toEqual(link)
    expect(await links.find('github', 's'.repeat(255))).toBeNull()
    await links.create({ ...link, provider: 'github', subject: '42' })
    expect((await links.forUser('u1')).map((l) => l.provider).sort()).toEqual(['github', 'google'])
    await links.remove('github', '42')
    expect(await links.find('github', '42')).toBeNull()
    await links.deleteAllForUser('u1')
    expect(await links.forUser('u1')).toEqual([])
  })

  it('drives Auth.socialLogin: a second subject cannot claim a linked email', async () => {
    const s = prismaAuthStores(makeFakeClient())
    const auth = new Auth({ secret, users: s.users, accountLinks: s.accountLinks, hasher, loginThrottle: false, ipLoginThrottle: false })
    const first = await auth.socialLogin('dev@corp.test', { emailVerified: true, identity: { provider: 'okta', subject: '00u1' } })
    const renamed = await auth.socialLogin('dev2@corp.test', { emailVerified: true, identity: { provider: 'okta', subject: '00u1' } })
    expect(renamed.user.id).toBe(first.user.id)
    await expect(
      auth.socialLogin('dev@corp.test', { emailVerified: true, identity: { provider: 'okta', subject: '00u2' } }),
    ).rejects.toBeInstanceOf(AccountLinkConflictError)
  })

  it('a client generated without the new models fails with an actionable error at first use', async () => {
    const s = prismaAuthStores(makeFakeClient({ withoutNewModels: true }))
    await expect(s.accountLinks.find('google', '1')).rejects.toBeInstanceOf(AuthModelMissingError)
    await expect(s.passkeys.get('c')).rejects.toBeInstanceOf(AuthModelMissingError)
  })
})

describe('PrismaPasskeyStore (FA-059)', () => {
  const credential = {
    id: 'A'.repeat(1300), // credential ids reach 1 023 bytes — longer than any indexed MySQL VARCHAR
    userId: 'u1',
    publicKey: 'pk',
    counter: 4_000_000_000, // past a signed 32-bit Int
    transports: ['usb', 'nfc'],
    deviceName: 'Key',
    createdAt: 1000,
  }

  it('round-trips a credential and compare-and-sets the counter', async () => {
    const store = new PrismaPasskeyStore(makeFakeClient())
    await store.add(credential)
    expect(await store.get(credential.id)).toEqual(credential)
    expect(await store.forUser('u1')).toHaveLength(1)
    expect(await store.compareAndSetCounter(credential.id, 1, 2, 5)).toBe(false)
    expect(await store.compareAndSetCounter(credential.id, credential.counter, credential.counter + 1, 5)).toBe(true)
    expect(await store.get(credential.id)).toMatchObject({ counter: credential.counter + 1, lastUsedAt: 5 })
    await store.remove(credential.id)
    expect(await store.get(credential.id)).toBeNull()
  })

  it('two concurrent assertions of a cloned authenticator: only one passes', async () => {
    const credentials = new PrismaPasskeyStore(makeFakeClient())
    await credentials.add({ ...credential, id: 'cred-1', counter: 5 })
    const verifier: WebAuthnVerifier = {
      async verifyRegistration() {
        return { verified: false }
      },
      async verifyAuthentication() {
        await new Promise((r) => setTimeout(r, 5))
        return { verified: true, newCounter: 6 }
      },
    }
    let n = 0
    const service = new WebAuthnService({
      config: { rpId: 'example.com', rpName: 'Example', origin: 'https://example.com' },
      credentials,
      challenges: new MemoryWebAuthnChallengeStore(),
      verifier,
      randomChallenge: () => `c-${++n}`,
    })
    await service.startAuthentication('a', 'u1')
    await service.startAuthentication('b', 'u1')
    const results = await Promise.allSettled([
      service.finishAuthentication('a', { id: 'cred-1' }),
      service.finishAuthentication('b', { id: 'cred-1' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(PasskeyClonedError)
  })
})
