import { describe, expect, it } from 'vitest'
import {
  ColumnLengthError,
  PrismaMfaStore,
  PrismaApiKeyStore,
  PrismaUserSource,
  type PrismaAuthClient,
  prismaAuthStores,
} from '../src/index.js'
import { makeFakeClient } from './fake-client.js'

/**
 * FA-070 · On MySQL a bare `String` is VARCHAR(191), and outside strict mode a
 * longer value is truncated silently: a cut password hash never verifies, a
 * cut sealed TOTP secret no longer opens. `columnLimits` refuses the write.
 */

/** Wraps a delegate method to count the writes that reach the database. */
function counting(client: PrismaAuthClient): { client: PrismaAuthClient; writes: string[] } {
  const writes: string[] = []
  for (const [name, delegate] of Object.entries(client)) {
    if (typeof delegate !== 'object' || delegate === null) continue
    for (const method of ['create', 'upsert', 'update', 'updateMany'] as const) {
      const fn = (delegate as Record<string, unknown>)[method]
      if (typeof fn !== 'function') continue
      ;(delegate as Record<string, unknown>)[method] = (args: unknown) => {
        writes.push(`${name}.${method}`)
        return (fn as (a: unknown) => unknown).call(delegate, args)
      }
    }
  }
  return { client, writes }
}

const now = Date.now()

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it("'mysql' refuses an email over 254 characters and a >191 id — before any query", async () => {
    const { client, writes } = counting(makeFakeClient())
    const users = new PrismaUserSource(client, { columnLimits: 'mysql' })
    await expect(users.create({ email: `${'a'.repeat(64)}@${'b'.repeat(190)}.test`, passwordHash: 'h' })).rejects.toMatchObject({
      code: 'COLUMN_LENGTH_EXCEEDED',
      status: 422,
      column: 'AuthUser.email',
      limit: 254,
    })
    // A long password hash is TEXT and fits.
    const ok = await users.create({ email: 'ana@example.com', passwordHash: `$scrypt$${'x'.repeat(400)}` })
    expect(ok.passwordHash).toHaveLength(408)
    expect(writes).toEqual(['authUser.create'])
  })

  it("'mysql' guards each store's writes", async () => {
    const { client, writes } = counting(makeFakeClient())
    const s = prismaAuthStores(client, { columnLimits: 'mysql' })
    const long = 'x'.repeat(192)
    await expect(s.tokens.create({ token: 't', userId: 'u1', purpose: long as never, expiresAt: now })).rejects.toThrow(
      /AuthToken\.purpose is 192 characters/,
    )
    await expect(s.refreshTokens.create({ token: long, familyId: 'f', userId: 'u1', expiresAt: now })).rejects.toThrow(
      /AuthRefreshToken\.token/,
    )
    await expect(s.sessions.create(long, 60_000)).rejects.toThrow(/AuthSession\.userId/)
    await expect(
      s.apiKeys.create({ id: 'k1', name: 'ci', prefix: long, hash: 'h', scopes: ['*'], createdAt: now }),
    ).rejects.toThrow(/AuthApiKey\.prefix/)
    await expect(s.mfa.set(long, { secret: 's', enabled: false, recoveryCodes: [] })).rejects.toThrow(/AuthMfa\.userId/)
    await expect(s.tokenVersions.increment(long)).rejects.toThrow(/AuthTokenVersion\.userId/)
    await expect(
      s.accountLinks.create({ provider: long, subject: 'sub', userId: 'u1', email: 'a@b.c', createdAt: now }),
    ).rejects.toThrow(/AuthAccountLink\.provider/)
    await expect(
      s.passkeys.add({ id: 'cred', userId: long, publicKey: 'pk', counter: 0, createdAt: now }),
    ).rejects.toBeInstanceOf(ColumnLengthError)
    expect(writes).toEqual([])
  })

  it("'mysql' accepts what the MySQL schema widened: 255-character OIDC subjects, 1 023-byte credential ids, sealed secrets", async () => {
    const s = prismaAuthStores(makeFakeClient(), { columnLimits: 'mysql' })
    expect(
      await s.accountLinks.create({ provider: 'oidc', subject: 's'.repeat(255), userId: 'u1', email: 'a@b.c', createdAt: now }),
    ).toBe(true)
    const credentialId = 'c'.repeat(1_364) // base64url of 1 023 bytes
    await s.passkeys.add({ id: credentialId, userId: 'u1', publicKey: 'p'.repeat(2_000), counter: 0, createdAt: now })
    expect((await s.passkeys.get(credentialId))?.publicKey).toHaveLength(2_000)
    await s.mfa.set('u1', { secret: `bka2.k1.${'e'.repeat(300)}`, enabled: true, recoveryCodes: ['h1'] })
    expect((await s.mfa.get('u1'))?.secret).toHaveLength(308)
  })

  it('update() checks the patched password hash against a custom limit', async () => {
    const { client, writes } = counting(makeFakeClient())
    const users = new PrismaUserSource(client, { columnLimits: { AuthUser: { passwordHash: 191 } } })
    const u = await users.create({ email: 'ana@example.com', passwordHash: 'h' })
    await expect(users.update(u.id, { passwordHash: 'h'.repeat(192) })).rejects.toThrow(/AuthUser\.passwordHash/)
    expect(writes).toEqual(['authUser.create'])
  })

  it('a malformed limit fails at wiring time', () => {
    expect(() => prismaAuthStores(makeFakeClient(), { columnLimits: { AuthUser: { email: 1.5 } } })).toThrow(TypeError)
    expect(() => new PrismaApiKeyStore(makeFakeClient(), { columnLimits: 'mariadb' as never })).toThrow(TypeError)
  })

  it('unset: no check (PostgreSQL / SQLite)', async () => {
    const s = prismaAuthStores(makeFakeClient())
    await s.tokenVersions.increment('u'.repeat(500))
    expect(await s.tokenVersions.get('u'.repeat(500))).toBe(1)
  })
})

describe('Json string lists (schema.mysql.prisma has no scalar lists)', () => {
  it('reads scopes / recovery codes stored as a JSON array, and an unexpected value as empty', async () => {
    const rows: Record<string, unknown> = { u1: { userId: 'u1', secret: 's', enabled: true, recoveryCodes: null, lastUsedStep: null } }
    const client = {
      authMfa: {
        findUnique: async ({ where }: { where: { userId: string } }) => rows[where.userId] ?? null,
        updateMany: async () => ({ count: 0 }),
        upsert: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
    } as unknown as PrismaAuthClient
    const mfa = new PrismaMfaStore(client)
    expect((await mfa.get('u1'))?.recoveryCodes).toEqual([])
    expect(await mfa.consumeRecoveryCode('u1', 'h1')).toBe(false)
    rows.u1 = { ...(rows.u1 as object), recoveryCodes: ['h1', 7, 'h2'] }
    expect((await mfa.get('u1'))?.recoveryCodes).toEqual(['h1', 'h2'])
  })
})
