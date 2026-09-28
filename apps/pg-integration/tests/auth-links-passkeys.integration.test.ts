import { PrismaPg } from '@prisma/adapter-pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaAccountLinkStore, PrismaPasskeyStore, prismaAuthStores } from '@basaltkit/auth-prisma'

// Real-PostgreSQL checks for the two auth stores added by the framework audit
// (FA-058 account links, FA-059 passkey clone detection). Their guarantees are
// atomic in SQL — a primary-key insert and a conditional UPDATE — so they are
// only proven against a real database, where concurrent statements genuinely
// race, not against the in-memory fakes. Gated on TEST_DATABASE_URL.
const url = process.env['TEST_DATABASE_URL']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any

describe.skipIf(!url)('auth-prisma account links and passkeys against real PostgreSQL', () => {
  beforeAll(async () => {
    const clientModule: string = '../generated/client/index.js'
    const { PrismaClient } = (await import(clientModule)) as { PrismaClient: new (opts?: unknown) => unknown }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
    await Promise.all([prisma.authAccountLink.deleteMany(), prisma.authPasskey.deleteMany()])
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  it('account links: round-trip, a 255-character OIDC subject, per-user listing and removal', async () => {
    const links: PrismaAccountLinkStore = prismaAuthStores(prisma).accountLinks
    const subject = 's'.repeat(255)
    expect(await links.create({ provider: 'oidc', subject, userId: 'u1', email: 'a@b.test', createdAt: 1_000 })).toBe(true)
    expect(await links.create({ provider: 'google', subject: '42', userId: 'u1', email: 'a@b.test', createdAt: 2_000 })).toBe(true)
    expect(await links.find('oidc', subject)).toEqual({ provider: 'oidc', subject, userId: 'u1', email: 'a@b.test', createdAt: 1_000 })
    // Same subject, another provider: a different identity.
    expect(await links.find('google', subject)).toBeNull()
    expect((await links.forUser('u1')).map((l) => l.provider)).toEqual(['oidc', 'google'])
    await links.remove('oidc', subject)
    expect(await links.find('oidc', subject)).toBeNull()
    await links.deleteAllForUser('u1')
    expect(await links.forUser('u1')).toEqual([])
  })

  it('account links: concurrent creates of one (provider, subject) — exactly one wins (atomic insert)', async () => {
    const links = new PrismaAccountLinkStore(prisma)
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        links.create({ provider: 'github', subject: 'race', userId: `user-${i}`, email: `u${i}@b.test`, createdAt: 3_000 + i }),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results.indexOf(true)
    expect((await links.find('github', 'race'))?.userId).toBe(`user-${winner}`)
    // A later duplicate is a clean `false` (P2002), not a thrown error.
    expect(await links.create({ provider: 'github', subject: 'race', userId: 'late', email: 'l@b.test', createdAt: 9_000 })).toBe(false)
  })

  it('passkeys: round-trip with a 1 023-byte credential id, a counter past 2^31 and transports', async () => {
    const passkeys: PrismaPasskeyStore = prismaAuthStores(prisma).passkeys
    const id = 'c'.repeat(1_364) // base64url of 1 023 bytes
    await passkeys.add({
      id,
      userId: 'u2',
      publicKey: 'pk'.repeat(200),
      counter: 4_294_967_294,
      transports: ['usb', 'nfc'],
      deviceName: 'YubiKey',
      createdAt: 5_000,
    })
    const cred = await passkeys.get(id)
    expect(cred).toMatchObject({ id, userId: 'u2', counter: 4_294_967_294, transports: ['usb', 'nfc'], deviceName: 'YubiKey' })
    expect(await passkeys.compareAndSetCounter(id, 4_294_967_294, 4_294_967_295, 6_000)).toBe(true)
    expect(await passkeys.get(id)).toMatchObject({ counter: 4_294_967_295, lastUsedAt: 6_000 })
    expect((await passkeys.forUser('u2')).map((c) => c.id)).toEqual([id])
    await passkeys.remove(id)
    expect(await passkeys.get(id)).toBeNull()
  })

  it('passkeys: concurrent compareAndSetCounter on one counter — exactly one wins (clone detection)', async () => {
    const passkeys = new PrismaPasskeyStore(prisma)
    await passkeys.add({ id: 'cloned', userId: 'u3', publicKey: 'pk', counter: 10, createdAt: 7_000 })
    // A cloned authenticator racing the genuine one: both present counter 11
    // against the stored 10. Only one conditional UPDATE may match.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => passkeys.compareAndSetCounter('cloned', 10, 11, 8_000 + i)),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await passkeys.get('cloned'))?.counter).toBe(11)
    // A stale expectation fails and leaves the counter alone.
    expect(await passkeys.compareAndSetCounter('cloned', 10, 12, 9_000)).toBe(false)
    expect(await passkeys.compareAndSetCounter('missing', 0, 1, 9_000)).toBe(false)
    expect((await passkeys.get('cloned'))?.counter).toBe(11)
  })
})
