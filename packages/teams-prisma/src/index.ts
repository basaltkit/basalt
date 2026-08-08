import type {
  Invitation,
  InvitationStore,
  Membership,
  MembershipStore,
  TeamRole,
} from '@machize/teams'

/**
 * Prisma-backed implementations of the `@machize/teams` stores (memberships and
 * invitations) for production databases (PostgreSQL, MySQL, …). Bring your
 * generated `PrismaClient` whose schema includes the `Team*` models (see the
 * bundled `prisma/schema.prisma`); the stores only touch those delegates.
 *
 * The production counterpart to `@machize/teams-sqlite` — same contracts,
 * different backend.
 */

// Prisma-return row shapes (DateTime → Date; nullable columns → null).
interface PMembership {
  tenantId: string
  userId: string
  role: string
  createdAt: Date
}
interface PInvitation {
  id: string
  tenantId: string
  email: string
  role: string
  token: string
  invitedBy: string | null
  expiresAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
}

/**
 * The minimal Prisma delegate surface the stores call — a real `PrismaClient`
 * with the `Team*` models is assignable, so pass it directly. Method arguments
 * are typed `any` on purpose (Prisma's generated method generics can't be
 * reproduced by a hand-written interface); return types stay precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaTeamsClient {
  teamMembership: {
    findUnique(a: any): Promise<PMembership | null>
    findMany(a: any): Promise<PMembership[]>
    upsert(a: any): Promise<PMembership>
    updateMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
  }
  teamInvitation: {
    findUnique(a: any): Promise<PInvitation | null>
    findFirst(a: any): Promise<PInvitation | null>
    findMany(a: any): Promise<PInvitation[]>
    create(a: any): Promise<PInvitation>
    updateMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// The @machize/teams contracts model time as epoch-ms numbers; Prisma models it
// as DateTime. Convert at the edges.
const ms = (d: Date): number => d.getTime()
const at = (n: number): Date => new Date(n)

// --- memberships ------------------------------------------------------------

const toMembership = (r: PMembership): Membership => ({
  tenantId: r.tenantId,
  userId: r.userId,
  role: r.role,
  createdAt: ms(r.createdAt),
})

export class PrismaMembershipStore implements MembershipStore {
  constructor(private readonly client: PrismaTeamsClient) {}

  async add(membership: Membership): Promise<void> {
    await this.client.teamMembership.upsert({
      where: { tenantId_userId: { tenantId: membership.tenantId, userId: membership.userId } },
      create: {
        tenantId: membership.tenantId,
        userId: membership.userId,
        role: membership.role,
        createdAt: at(membership.createdAt),
      },
      update: { role: membership.role, createdAt: at(membership.createdAt) },
    })
  }

  async find(tenantId: string, userId: string): Promise<Membership | null> {
    const r = await this.client.teamMembership.findUnique({ where: { tenantId_userId: { tenantId, userId } } })
    return r ? toMembership(r) : null
  }

  async list(tenantId: string): Promise<Membership[]> {
    const rows = await this.client.teamMembership.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toMembership)
  }

  async setRole(tenantId: string, userId: string, role: TeamRole): Promise<void> {
    await this.client.teamMembership.updateMany({ where: { tenantId, userId }, data: { role } })
  }

  async remove(tenantId: string, userId: string): Promise<void> {
    await this.client.teamMembership.deleteMany({ where: { tenantId, userId } })
  }
}

// --- invitations ------------------------------------------------------------

const toInvitation = (r: PInvitation): Invitation => {
  const inv: Invitation = {
    id: r.id,
    tenantId: r.tenantId,
    email: r.email,
    role: r.role,
    token: r.token,
    expiresAt: ms(r.expiresAt),
  }
  if (r.invitedBy !== null) inv.invitedBy = r.invitedBy
  if (r.acceptedAt !== null) inv.acceptedAt = ms(r.acceptedAt)
  if (r.revokedAt !== null) inv.revokedAt = ms(r.revokedAt)
  return inv
}

// pending = not accepted and not revoked (expiry is the caller's concern)
const PENDING = { acceptedAt: null, revokedAt: null }

export class PrismaInvitationStore implements InvitationStore {
  constructor(private readonly client: PrismaTeamsClient) {}

  async create(invitation: Invitation): Promise<void> {
    await this.client.teamInvitation.create({
      data: {
        id: invitation.id,
        tenantId: invitation.tenantId,
        email: invitation.email,
        role: invitation.role,
        token: invitation.token,
        invitedBy: invitation.invitedBy ?? null,
        expiresAt: at(invitation.expiresAt),
        acceptedAt: invitation.acceptedAt !== undefined ? at(invitation.acceptedAt) : null,
        revokedAt: invitation.revokedAt !== undefined ? at(invitation.revokedAt) : null,
      },
    })
  }

  async findByToken(token: string): Promise<Invitation | null> {
    const r = await this.client.teamInvitation.findUnique({ where: { token } })
    return r ? toInvitation(r) : null
  }

  async findById(id: string): Promise<Invitation | null> {
    const r = await this.client.teamInvitation.findUnique({ where: { id } })
    return r ? toInvitation(r) : null
  }

  async listPending(tenantId: string): Promise<Invitation[]> {
    const rows = await this.client.teamInvitation.findMany({
      where: { tenantId, ...PENDING },
      orderBy: { expiresAt: 'asc' },
    })
    return rows.map(toInvitation)
  }

  async findPending(tenantId: string, email: string): Promise<Invitation | null> {
    const r = await this.client.teamInvitation.findFirst({ where: { tenantId, email, ...PENDING } })
    return r ? toInvitation(r) : null
  }

  async markAccepted(id: string, at_: number): Promise<void> {
    await this.client.teamInvitation.updateMany({ where: { id }, data: { acceptedAt: at(at_) } })
  }

  async revoke(id: string, at_: number): Promise<void> {
    await this.client.teamInvitation.updateMany({ where: { id }, data: { revokedAt: at(at_) } })
  }
}

// --- convenience ------------------------------------------------------------

export interface PrismaTeamsStores {
  memberships: PrismaMembershipStore
  invitations: PrismaInvitationStore
}

/**
 * Wire both team stores to your Prisma client, named to drop straight into
 * `teamsPlugin`:
 *
 * ```ts
 * const t = prismaTeamsStores(prisma)
 * teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
 * ```
 */
// Fail fast with an actionable message when the Prisma client lacks the models
// this package needs (the alternative is a cryptic "reading 'create' of undefined").
function ensureModel(client: unknown, delegate: string, pkg: string): void {
  let value: unknown
  try {
    value = (client as Record<string, unknown>)[delegate]
  } catch {
    return // lazy/proxy client (e.g. database-per-tenant) — validated at first use
  }
  if (value == null) {
    throw new Error(
      `${pkg}: the Prisma client has no \`${delegate}\` model. Add its models to your ` +
        `schema.prisma (run \`mach prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

export function prismaTeamsStores(client: PrismaTeamsClient): PrismaTeamsStores {
  ensureModel(client, 'teamMembership', '@machize/teams-prisma')
  return {
    memberships: new PrismaMembershipStore(client),
    invitations: new PrismaInvitationStore(client),
  }
}
