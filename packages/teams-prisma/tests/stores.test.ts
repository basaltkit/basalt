import { beforeEach, describe, expect, it } from 'vitest'
import {
  PrismaInvitationStore,
  PrismaMembershipStore,
  type PrismaTeamsClient,
  prismaTeamsStores,
} from '../src/index.js'

interface MRow { tenantId: string; userId: string; role: string; createdAt: Date }
interface IRow {
  id: string; tenantId: string; email: string; role: string; token: string
  invitedBy: string | null; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null
}

// In-memory fake of the Prisma delegate surface — the injectable-client pattern.
function makeFakeClient(): PrismaTeamsClient {
  const members = new Map<string, MRow>()
  const invites = new Map<string, IRow>()
  const mkey = (t: string, u: string): string => `${t}::${u}`
  const pending = (i: IRow): boolean => i.acceptedAt === null && i.revokedAt === null

  return {
    teamMembership: {
      async findUnique({ where }) {
        const { tenantId, userId } = where.tenantId_userId
        return members.get(mkey(tenantId, userId)) ?? null
      },
      async findMany({ where }) {
        return [...members.values()]
          .filter((m) => m.tenantId === where.tenantId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      },
      async upsert({ where, create, update }) {
        const { tenantId, userId } = where.tenantId_userId
        const existing = members.get(mkey(tenantId, userId))
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create } as MRow
        members.set(mkey(row.tenantId, row.userId), row)
        return row
      },
      async updateMany({ where, data }) {
        const row = members.get(mkey(where.tenantId, where.userId))
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
      async deleteMany({ where }) {
        return { count: members.delete(mkey(where.tenantId, where.userId)) ? 1 : 0 }
      },
    },
    teamInvitation: {
      async findUnique({ where }) {
        if (where.id !== undefined) return invites.get(where.id) ?? null
        if (where.token !== undefined) {
          for (const i of invites.values()) if (i.token === where.token) return i
        }
        return null
      },
      async findFirst({ where }) {
        for (const i of invites.values()) {
          if (i.tenantId === where.tenantId && i.email === where.email && pending(i)) return i
        }
        return null
      },
      async findMany({ where }) {
        return [...invites.values()]
          .filter((i) => i.tenantId === where.tenantId && pending(i))
          .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
      },
      async create({ data }) {
        if ([...invites.values()].some((i) => i.token === data.token)) throw new Error('unique token')
        const row = { ...data } as IRow
        invites.set(row.id, row)
        return row
      },
      async updateMany({ where, data }) {
        const row = invites.get(where.id)
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
    },
  }
}

let client: PrismaTeamsClient
beforeEach(() => {
  client = makeFakeClient()
})

describe('PrismaMembershipStore', () => {
  it('adds, finds, lists, re-roles and removes', async () => {
    const store = new PrismaMembershipStore(client)
    await store.add({ tenantId: 'acme', userId: 'u1', role: 'admin', createdAt: 1 })
    await store.add({ tenantId: 'acme', userId: 'u2', role: 'member', createdAt: 2 })
    await store.add({ tenantId: 'other', userId: 'u1', role: 'member', createdAt: 3 })

    expect((await store.find('acme', 'u1'))?.role).toBe('admin')
    expect((await store.find('acme', 'u1'))?.createdAt).toBe(1) // round-trips epoch-ms
    expect(await store.find('acme', 'ghost')).toBeNull()
    expect((await store.list('acme')).map((m) => m.userId)).toEqual(['u1', 'u2'])
    expect((await store.list('other')).length).toBe(1)

    await store.setRole('acme', 'u2', 'admin')
    expect((await store.find('acme', 'u2'))?.role).toBe('admin')

    await store.add({ tenantId: 'acme', userId: 'u1', role: 'owner', createdAt: 9 }) // upsert
    expect((await store.find('acme', 'u1'))?.role).toBe('owner')

    await store.remove('acme', 'u1')
    expect(await store.find('acme', 'u1')).toBeNull()
    expect((await store.list('acme')).length).toBe(1)
  })
})

describe('PrismaInvitationStore', () => {
  it('creates, looks up, lists pending, accepts and revokes', async () => {
    const store = new PrismaInvitationStore(client)
    await store.create({ id: 'i1', tenantId: 'acme', email: 'a@x.com', role: 'member', token: 'tok1', invitedBy: 'admin', expiresAt: 100 })
    await store.create({ id: 'i2', tenantId: 'acme', email: 'b@x.com', role: 'member', token: 'tok2', expiresAt: 100 })
    await store.create({ id: 'i3', tenantId: 'other', email: 'c@x.com', role: 'member', token: 'tok3', expiresAt: 100 })

    expect((await store.findByToken('tok1'))?.id).toBe('i1')
    expect((await store.findByToken('tok1'))?.invitedBy).toBe('admin')
    expect((await store.findById('i2'))?.invitedBy).toBeUndefined()
    expect(await store.findByToken('nope')).toBeNull()
    expect(await store.findById('nope')).toBeNull()

    expect((await store.listPending('acme')).map((i) => i.id)).toEqual(['i1', 'i2'])
    expect((await store.findPending('acme', 'a@x.com'))?.id).toBe('i1')
    expect(await store.findPending('acme', 'missing@x.com')).toBeNull()

    await store.markAccepted('i1', 500)
    expect((await store.findById('i1'))?.acceptedAt).toBe(500)
    expect((await store.listPending('acme')).map((i) => i.id)).toEqual(['i2'])
    expect(await store.findPending('acme', 'a@x.com')).toBeNull()

    await store.revoke('i2', 600)
    expect((await store.findById('i2'))?.revokedAt).toBe(600)
    expect((await store.listPending('acme')).length).toBe(0)
  })

  it('round-trips an invitation created already-accepted/revoked', async () => {
    const store = new PrismaInvitationStore(client)
    await store.create({ id: 'x', tenantId: 't', email: 'e@x.com', role: 'member', token: 'tk', expiresAt: 10, acceptedAt: 20, revokedAt: 30 })
    const inv = await store.findById('x')
    expect(inv?.acceptedAt).toBe(20)
    expect(inv?.revokedAt).toBe(30)
  })

  it('rejects duplicate tokens', async () => {
    const store = new PrismaInvitationStore(client)
    const inv = { id: 'x', tenantId: 't', email: 'e@x.com', role: 'member', token: 'same', expiresAt: 1 }
    await store.create(inv)
    await expect(store.create({ ...inv, id: 'y' })).rejects.toThrow()
  })
})

describe('prismaTeamsStores', () => {
  it('bundles both stores named for teamsPlugin', () => {
    const t = prismaTeamsStores(client)
    expect(t.memberships).toBeInstanceOf(PrismaMembershipStore)
    expect(t.invitations).toBeInstanceOf(PrismaInvitationStore)
  })
})
