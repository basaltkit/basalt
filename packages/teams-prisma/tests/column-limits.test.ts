import { describe, expect, it } from 'vitest'
import type { Invitation } from '@basaltkit/teams'
import {
  ColumnLengthError,
  PrismaInvitationStore,
  PrismaMembershipStore,
  type PrismaTeamsClient,
  prismaTeamsStores,
} from '../src/index.js'

type Row = Record<string, unknown>

/** A MySQL-outside-strict-mode fake: every string column is VARCHAR(191) and a longer value is cut. */
function mysqlLikeClient(): { client: PrismaTeamsClient; members: Row[]; invites: Row[]; roleUpdates: Row[] } {
  const members: Row[] = []
  const invites: Row[] = []
  const roleUpdates: Row[] = []
  const cut = (data: Row): Row =>
    Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 191) : v]))
  const client: PrismaTeamsClient = {
    teamMembership: {
      findUnique: async () => null,
      findMany: async () => members as never,
      upsert: async ({ create }) => {
        members.push(cut(create))
        return create
      },
      updateMany: async ({ data }) => {
        roleUpdates.push(cut(data))
        return { count: 1 }
      },
      deleteMany: async () => ({ count: 0 }),
    },
    teamInvitation: {
      findUnique: async ({ where }) => (invites.find((i) => i.token === where.token) ?? null) as never,
      findFirst: async () => null,
      findMany: async () => invites as never,
      create: async ({ data }) => {
        invites.push(cut(data))
        return data
      },
      updateMany: async () => ({ count: 0 }),
    },
  }
  return { client, members, invites, roleUpdates }
}

// A valid address of 250 characters: 64-character local part, long domain.
const longEmail = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(59)}.com`

const invite = (over: Partial<Invitation> = {}): Invitation => ({
  id: 'inv-1',
  tenantId: 'acme',
  email: 'ana@example.com',
  role: 'member',
  token: 't'.repeat(43),
  expiresAt: Date.now() + 60_000,
  ...over,
})

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it('without the guard a 250-character email is cut to 191 — it no longer names the recipient', async () => {
    expect(longEmail.length).toBe(250)
    const { client, invites } = mysqlLikeClient()
    await new PrismaInvitationStore(client).create(invite({ email: longEmail }))
    expect((invites[0]!.email as string).length).toBe(191)
  })

  it("'mysql' accepts a 254-character email (VARCHAR(254)) but refuses a longer one", async () => {
    const { client, invites } = mysqlLikeClient()
    const { invitations } = prismaTeamsStores(client, { columnLimits: 'mysql' })
    await invitations.create(invite({ email: `${'a'.repeat(64)}@${'b'.repeat(185)}.com` }))
    expect(invites).toHaveLength(1)
    await expect(invitations.create(invite({ email: `${'a'.repeat(64)}@${'b'.repeat(186)}.com` }))).rejects.toMatchObject({
      code: 'COLUMN_LENGTH_EXCEEDED',
      column: 'TeamInvitation.email',
      limit: 254,
    })
    expect(invites).toHaveLength(1)
  })

  it("'mysql' refuses a token, role or invitedBy over VARCHAR(191) — a cut token hash would not match its link", async () => {
    const { client, invites } = mysqlLikeClient()
    const store = new PrismaInvitationStore(client, { columnLimits: 'mysql' })
    await expect(store.create(invite({ token: 't'.repeat(192) }))).rejects.toThrow(/TeamInvitation\.token is 192 characters/)
    await expect(store.create(invite({ role: 'r'.repeat(192) }))).rejects.toBeInstanceOf(ColumnLengthError)
    await expect(store.create(invite({ invitedBy: 'u'.repeat(192) }))).rejects.toThrow(/TeamInvitation\.invitedBy/)
    expect(invites).toHaveLength(0)
  })

  it("'mysql' guards memberships: add and setRole", async () => {
    const { client, members, roleUpdates } = mysqlLikeClient()
    const { memberships } = prismaTeamsStores(client, { columnLimits: 'mysql' })
    await expect(
      memberships.add({ tenantId: 'acme', userId: 'u'.repeat(192), role: 'member', createdAt: 1 }),
    ).rejects.toThrow(/TeamMembership\.userId/)
    await expect(memberships.setRole('acme', 'u1', 'r'.repeat(192))).rejects.toThrow(/TeamMembership\.role/)
    await memberships.add({ tenantId: 'acme', userId: 'u1', role: 'member', createdAt: 1 })
    await memberships.setRole('acme', 'u1', 'admin')
    expect(members).toHaveLength(1)
    expect(roleUpdates).toEqual([{ role: 'admin' }])
  })

  it('custom limits and wiring-time validation', async () => {
    const { client } = mysqlLikeClient()
    const store = new PrismaMembershipStore(client, { columnLimits: { TeamMembership: { role: 8 } } })
    await expect(store.setRole('acme', 'u1', 'supervisor')).rejects.toThrow(/TeamMembership\.role is 10 characters/)
    expect(() => prismaTeamsStores(client, { columnLimits: { TeamInvitation: { email: { bytes: -1 } } } })).toThrow(TypeError)
  })

  it('unset: no check (PostgreSQL / SQLite)', async () => {
    const { client, invites } = mysqlLikeClient()
    await prismaTeamsStores(client).invitations.create(invite({ token: 't'.repeat(500) }))
    expect(invites).toHaveLength(1)
  })
})
