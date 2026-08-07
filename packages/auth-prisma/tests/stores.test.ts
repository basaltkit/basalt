import { beforeEach, describe, expect, it } from 'vitest'
import {
  PrismaApiKeyStore,
  PrismaAuthTokenStore,
  type PrismaAuthClient,
  PrismaMfaStore,
  PrismaRefreshTokenStore,
  PrismaSessionStore,
  PrismaUserSource,
  prismaAuthStores,
} from '../src/index.js'

// A faithful in-memory fake of the Prisma delegate surface the stores use —
// the same "injectable client" pattern the cloud drivers test with. If a real
// PrismaClient satisfies `PrismaAuthClient`, so must this.
function makeFakeClient(): PrismaAuthClient {
  const users = new Map<string, PUserRow>()
  const sessions = new Map<string, PSessionRow>()
  const refresh = new Map<string, PRefreshRow>()
  const tokens = new Map<string, PTokenRow>()
  const apiKeys = new Map<string, PApiKeyRow>()
  const mfa = new Map<string, PMfaRow>()

  return {
    authUser: {
      async findUnique({ where }) {
        if (where.id !== undefined) return users.get(where.id) ?? null
        if (where.email !== undefined) {
          for (const u of users.values()) if (u.email === where.email) return u
        }
        return null
      },
      async create({ data }) {
        if ([...users.values()].some((u) => u.email === data.email)) throw new Error('unique email')
        const row = { ...data }
        users.set(row.id, row)
        return row
      },
      async update({ where, data }) {
        const row = users.get(where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return row
      },
    },
    authSession: {
      async findUnique({ where }) {
        return sessions.get(where.id) ?? null
      },
      async create({ data }) {
        const row = { ...data }
        sessions.set(row.id, row)
        return row
      },
      async deleteMany({ where }) {
        return { count: sessions.delete(where.id) ? 1 : 0 }
      },
    },
    authRefreshToken: {
      async findUnique({ where }) {
        return refresh.get(where.token) ?? null
      },
      async create({ data }) {
        const row = { ...data }
        refresh.set(row.token, row)
        return row
      },
      async updateMany({ where, data }) {
        const row = refresh.get(where.token)
        if (!row) return { count: 0 }
        row.usedAt = data.usedAt
        return { count: 1 }
      },
      async deleteMany({ where }) {
        let count = 0
        for (const [k, r] of refresh) {
          if (where.familyId !== undefined && r.familyId !== where.familyId) continue
          if (where.userId !== undefined && r.userId !== where.userId) continue
          refresh.delete(k)
          count++
        }
        return { count }
      },
    },
    authToken: {
      async findUnique({ where }) {
        return tokens.get(where.token) ?? null
      },
      async create({ data }) {
        const row = { ...data }
        tokens.set(row.token, row)
        return row
      },
      async updateMany({ where, data }) {
        const row = tokens.get(where.token)
        if (!row) return { count: 0 }
        row.usedAt = data.usedAt
        return { count: 1 }
      },
      async deleteMany({ where }) {
        let count = 0
        for (const [k, r] of tokens) {
          if (r.userId === where.userId && r.purpose === where.purpose) {
            tokens.delete(k)
            count++
          }
        }
        return { count }
      },
    },
    authApiKey: {
      async findUnique({ where }) {
        if (where.id !== undefined) return apiKeys.get(where.id) ?? null
        if (where.hash !== undefined) {
          for (const k of apiKeys.values()) if (k.hash === where.hash) return k
        }
        return null
      },
      async findMany({ where, orderBy }) {
        let rows = [...apiKeys.values()].filter((k) => k.revokedAt === null)
        if (where.tenantId !== undefined) rows = rows.filter((k) => k.tenantId === where.tenantId)
        if (where.userId !== undefined) rows = rows.filter((k) => k.userId === where.userId)
        if (orderBy?.createdAt === 'asc') rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        return rows
      },
      async create({ data }) {
        if ([...apiKeys.values()].some((k) => k.hash === data.hash)) throw new Error('unique hash')
        const row = { ...data }
        apiKeys.set(row.id, row)
        return row
      },
      async update({ where, data }) {
        const row = apiKeys.get(where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return row
      },
    },
    authMfa: {
      async findUnique({ where }) {
        return mfa.get(where.userId) ?? null
      },
      async upsert({ where, create, update }) {
        const existing = mfa.get(where.userId)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create }
        mfa.set(row.userId, row)
        return row
      },
      async deleteMany({ where }) {
        return { count: mfa.delete(where.userId) ? 1 : 0 }
      },
    },
  }
}

// row shapes the fake stores (Prisma-return shape: Date / boolean / null)
interface PUserRow { id: string; email: string; passwordHash: string; emailVerified: boolean }
interface PSessionRow { id: string; userId: string; expiresAt: Date }
interface PRefreshRow { token: string; familyId: string; userId: string; expiresAt: Date; usedAt: Date | null }
interface PTokenRow { token: string; userId: string; purpose: string; expiresAt: Date; usedAt: Date | null }
interface PApiKeyRow {
  id: string; name: string; prefix: string; hash: string; tenantId: string | null
  userId: string | null; scopes: string[]; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null
}
interface PMfaRow { userId: string; secret: string; enabled: boolean; recoveryCodes: string[] }

let client: PrismaAuthClient
beforeEach(() => {
  client = makeFakeClient()
})

describe('PrismaUserSource', () => {
  it('creates, finds and updates users', async () => {
    const users = new PrismaUserSource(client)
    const created = await users.create({ email: 'a@b.com', passwordHash: 'h' })
    expect(created.id).toBeTruthy()
    expect(created.emailVerified).toBe(false)

    expect((await users.findByEmail('a@b.com'))?.id).toBe(created.id)
    expect((await users.findById(created.id))?.email).toBe('a@b.com')
    expect(await users.findByEmail('missing@b.com')).toBeNull()
    expect(await users.findById('nope')).toBeNull()

    const updated = await users.update(created.id, { emailVerified: true, passwordHash: 'h2' })
    expect(updated?.emailVerified).toBe(true)
    expect(updated?.passwordHash).toBe('h2')

    expect((await users.update(created.id, {}))?.email).toBe('a@b.com') // empty patch = read
  })

  it('rejects duplicate emails', async () => {
    const users = new PrismaUserSource(client)
    await users.create({ email: 'dup@b.com', passwordHash: 'h' })
    await expect(users.create({ email: 'dup@b.com', passwordHash: 'h' })).rejects.toThrow()
  })
})

describe('PrismaAuthTokenStore', () => {
  it('stores, marks used and clears by user/purpose', async () => {
    const store = new PrismaAuthTokenStore(client)
    await store.create({ token: 't1', userId: 'u1', purpose: 'verify_email', expiresAt: Date.now() + 1000 })
    expect((await store.find('t1'))?.userId).toBe('u1')
    expect((await store.find('t1'))?.usedAt).toBeUndefined()

    // a record created already-used round-trips its usedAt
    await store.create({ token: 'tu', userId: 'u1', purpose: 'verify_email', expiresAt: Date.now() + 1000, usedAt: 777 })
    expect((await store.find('tu'))?.usedAt).toBe(777)

    await store.markUsed('t1')
    expect((await store.find('t1'))?.usedAt).toBeGreaterThan(0)
    await store.markUsed('ghost') // tolerant no-op

    await store.create({ token: 't2', userId: 'u1', purpose: 'reset_password', expiresAt: Date.now() + 1000 })
    await store.deleteForUser('u1', 'verify_email')
    expect(await store.find('t1')).toBeNull()
    expect(await store.find('t2')).not.toBeNull()
    expect(await store.find('missing')).toBeNull()
  })
})

describe('PrismaSessionStore', () => {
  it('creates, finds and deletes', async () => {
    const store = new PrismaSessionStore(client)
    const s = await store.create('u1', 60_000)
    expect(s.userId).toBe('u1')
    expect((await store.find(s.id))?.id).toBe(s.id)
    expect(await store.delete(s.id)).toBe(true)
    expect(await store.delete(s.id)).toBe(false)
    expect(await store.find(s.id)).toBeNull()
  })

  it('treats expired sessions as gone and evicts them', async () => {
    const store = new PrismaSessionStore(client)
    const s = await store.create('u1', -1)
    expect(await store.find(s.id)).toBeNull()
    expect(await store.find(s.id)).toBeNull()
  })
})

describe('PrismaRefreshTokenStore', () => {
  it('handles reuse (family revoke) and password reset (user revoke)', async () => {
    const store = new PrismaRefreshTokenStore(client)
    await store.create({ token: 'r1', familyId: 'f1', userId: 'u1', expiresAt: Date.now() + 1000 })
    await store.create({ token: 'r2', familyId: 'f1', userId: 'u1', expiresAt: Date.now() + 1000 })
    await store.create({ token: 'r3', familyId: 'f2', userId: 'u2', expiresAt: Date.now() + 1000, usedAt: Date.now() })

    expect((await store.find('r1'))?.familyId).toBe('f1')
    expect((await store.find('r3'))?.usedAt).toBeGreaterThan(0) // round-trips usedAt on create
    await store.markUsed('r1')
    expect((await store.find('r1'))?.usedAt).toBeGreaterThan(0)

    await store.revokeFamily('f1')
    expect(await store.find('r1')).toBeNull()
    expect(await store.find('r2')).toBeNull()
    expect(await store.find('r3')).not.toBeNull()

    await store.revokeAllForUser('u2')
    expect(await store.find('r3')).toBeNull()
  })
})

describe('PrismaApiKeyStore', () => {
  it('creates, looks up, lists active, touches and revokes', async () => {
    const store = new PrismaApiKeyStore(client)
    const base = { name: 'k', prefix: 'mk_ab', scopes: ['*'], createdAt: Date.now() }
    await store.create({ id: 'k1', hash: 'h1', tenantId: 't1', userId: 'u1', ...base })
    await store.create({ id: 'k2', hash: 'h2', tenantId: 't1', ...base })
    await store.create({ id: 'k3', hash: 'h3', tenantId: 't2', ...base })

    expect((await store.findByHash('h1'))?.id).toBe('k1')
    expect((await store.findByHash('h1'))?.scopes).toEqual(['*'])
    expect((await store.findById('k2'))?.userId).toBeUndefined()
    expect(await store.findByHash('nope')).toBeNull()
    expect(await store.findById('nope')).toBeNull()

    expect((await store.list({ tenantId: 't1' })).map((k) => k.id).sort()).toEqual(['k1', 'k2'])
    expect((await store.list({ tenantId: 't1', userId: 'u1' })).map((k) => k.id)).toEqual(['k1'])
    expect((await store.list({})).length).toBe(3)

    await store.touch('k1', 12345)
    expect((await store.findById('k1'))?.lastUsedAt).toBe(12345)

    await store.revoke('k1', 999)
    expect((await store.findById('k1'))?.revokedAt).toBe(999)
    expect((await store.list({ tenantId: 't1' })).map((k) => k.id)).toEqual(['k2'])

    // a key created already-used/already-revoked round-trips both timestamps
    await store.create({ id: 'k4', hash: 'h4', tenantId: 't3', lastUsedAt: 111, revokedAt: 222, ...base })
    const k4 = await store.findById('k4')
    expect(k4?.lastUsedAt).toBe(111)
    expect(k4?.revokedAt).toBe(222)
  })

  it('rejects duplicate hashes', async () => {
    const store = new PrismaApiKeyStore(client)
    const rec = { id: 'x', name: 'k', prefix: 'p', hash: 'same', scopes: [], createdAt: Date.now() }
    await store.create(rec)
    await expect(store.create({ ...rec, id: 'y' })).rejects.toThrow()
  })
})

describe('PrismaMfaStore', () => {
  it('gets, upserts and deletes', async () => {
    const store = new PrismaMfaStore(client)
    expect(await store.get('u1')).toBeNull()

    await store.set('u1', { secret: 's', enabled: false, recoveryCodes: ['a', 'b'] })
    expect(await store.get('u1')).toEqual({ secret: 's', enabled: false, recoveryCodes: ['a', 'b'] })

    await store.set('u1', { secret: 's2', enabled: true, recoveryCodes: [] })
    expect(await store.get('u1')).toEqual({ secret: 's2', enabled: true, recoveryCodes: [] })

    await store.delete('u1')
    expect(await store.get('u1')).toBeNull()
  })
})

describe('prismaAuthStores', () => {
  it('bundles every store named for authPlugin/apiKeysPlugin', () => {
    const s = prismaAuthStores(client)
    expect(s.users).toBeInstanceOf(PrismaUserSource)
    expect(s.sessions).toBeInstanceOf(PrismaSessionStore)
    expect(s.refreshTokens).toBeInstanceOf(PrismaRefreshTokenStore)
    expect(s.tokens).toBeInstanceOf(PrismaAuthTokenStore)
    expect(s.apiKeys).toBeInstanceOf(PrismaApiKeyStore)
    expect(s.mfa).toBeInstanceOf(PrismaMfaStore)
  })
})
