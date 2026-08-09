import { randomBytes, randomUUID } from 'node:crypto'
import { BasaltError, parseDuration, type DurationInput, type HookBus } from '@basaltkit/core'
import {
  MemoryInvitationStore,
  MemoryMembershipStore,
  type Invitation,
  type InvitationStore,
  type Membership,
  type MembershipStore,
  type PublicInvitation,
  type TeamRole,
} from './stores.js'

/** An invite token was unknown, already used, revoked, or expired. */
export class TeamInviteInvalidError extends BasaltError {
  readonly status = 400
  constructor() {
    super('TEAM_INVITE_INVALID', 'This invitation link is invalid or has expired.')
  }
}

/** The acting user is not a member of the team. */
export class NotATeamMemberError extends BasaltError {
  readonly status = 403
  constructor() {
    super('TEAM_NOT_A_MEMBER', 'You are not a member of this team.')
  }
}

/** The acting user's role is below what the action requires. */
export class InsufficientTeamRoleError extends BasaltError {
  readonly status = 403
  constructor(required: TeamRole) {
    super('TEAM_ROLE_REQUIRED', `This action requires the "${required}" role or higher.`)
  }
}

/** Refused because it would leave the team with no owner. */
export class LastOwnerError extends BasaltError {
  readonly status = 400
  constructor() {
    super('TEAM_LAST_OWNER', 'A team must keep at least one owner.')
  }
}

/** Minimal role-store surface — a @basaltkit/permissions AccessStore satisfies it. */
export interface RoleAssigner {
  assignRole(userId: string, role: string, scope: string): Promise<void>
  removeRole(userId: string, role: string, scope: string): Promise<void>
}

/** Default role hierarchy; higher rank outranks lower. */
export const DEFAULT_ROLE_RANK: Readonly<Record<string, number>> = { owner: 3, admin: 2, member: 1 }
export const OWNER: TeamRole = 'owner'

export interface TeamsOptions {
  memberships?: MembershipStore
  invitations?: InvitationStore
  /** Wired to @basaltkit/permissions to mirror memberships into role grants. */
  access?: RoleAssigner
  hooks?: HookBus
  /** Invitation link lifetime. Default 7d. */
  inviteTtl?: DurationInput
  /** Override the role hierarchy (name → rank). */
  roleRank?: Record<string, number>
  /** Injectable clock for tests. */
  now?: () => number
}

const publicInvite = (i: Invitation): PublicInvitation => {
  const { token: _token, ...rest } = i
  return rest
}

/**
 * Team membership and email invitations for multi-user tenants. Decoupled from
 * auth and tenancy: identifiers are passed in. Optionally mirrors role changes
 * into a {@link RoleAssigner} (e.g. @basaltkit/permissions).
 */
export class Teams {
  private readonly memberships: MembershipStore
  private readonly invitations: InvitationStore
  private readonly access: RoleAssigner | undefined
  private readonly hooks: HookBus | undefined
  private readonly inviteTtl: DurationInput
  private readonly roleRank: Record<string, number>
  private readonly now: () => number

  constructor(options: TeamsOptions = {}) {
    this.memberships = options.memberships ?? new MemoryMembershipStore()
    this.invitations = options.invitations ?? new MemoryInvitationStore()
    this.access = options.access
    this.hooks = options.hooks
    this.inviteTtl = options.inviteTtl ?? '7d'
    this.roleRank = options.roleRank ?? { ...DEFAULT_ROLE_RANK }
    this.now = options.now ?? Date.now
  }

  rankOf(role: TeamRole): number {
    return this.roleRank[role] ?? 0
  }

  /** Directly adds/updates a membership — used to seed a team's first owner. */
  async addMember(tenantId: string, userId: string, role: TeamRole): Promise<Membership> {
    const existing = await this.memberships.find(tenantId, userId)
    const membership: Membership = { tenantId, userId, role, createdAt: existing?.createdAt ?? this.now() }
    await this.memberships.add(membership)
    await this.access?.assignRole(userId, role, tenantId)
    await this.hooks?.emit('team:joined', { membership })
    return membership
  }

  /**
   * Creates (or refreshes) an invitation and emits `team:invited` for the app
   * to email. Returns the public invitation plus the token (for building the
   * link). One pending invite per email per team — a new one supersedes it.
   */
  async invite(input: {
    tenantId: string
    email: string
    role?: TeamRole
    invitedBy?: string
  }): Promise<{ invitation: PublicInvitation; token: string }> {
    const existing = await this.invitations.findPending(input.tenantId, input.email)
    if (existing) await this.invitations.revoke(existing.id, this.now())

    const token = randomBytes(24).toString('base64url')
    const invitation: Invitation = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email: input.email,
      role: input.role ?? 'member',
      token,
      expiresAt: this.now() + parseDuration(this.inviteTtl),
      ...(input.invitedBy !== undefined ? { invitedBy: input.invitedBy } : {}),
    }
    await this.invitations.create(invitation)
    await this.hooks?.emit('team:invited', { invitation: publicInvite(invitation), token })
    return { invitation: publicInvite(invitation), token }
  }

  /**
   * Consumes an invitation token and enrolls `userId` at the invited role.
   * Idempotent for an already-accepted membership of the same user.
   */
  async accept(token: string, userId: string): Promise<Membership> {
    const invitation = await this.invitations.findByToken(token)
    if (
      !invitation ||
      invitation.acceptedAt !== undefined ||
      invitation.revokedAt !== undefined ||
      this.now() >= invitation.expiresAt
    ) {
      throw new TeamInviteInvalidError()
    }
    await this.invitations.markAccepted(invitation.id, this.now())
    return this.addMember(invitation.tenantId, userId, invitation.role)
  }

  async members(tenantId: string): Promise<Membership[]> {
    return this.memberships.list(tenantId)
  }

  async pendingInvites(tenantId: string): Promise<PublicInvitation[]> {
    const list = await this.invitations.listPending(tenantId)
    return list.filter((i) => this.now() < i.expiresAt).map(publicInvite)
  }

  async invitation(id: string): Promise<PublicInvitation | null> {
    const i = await this.invitations.findById(id)
    return i ? publicInvite(i) : null
  }

  async revokeInvite(id: string): Promise<void> {
    const i = await this.invitations.findById(id)
    if (i && i.acceptedAt === undefined && i.revokedAt === undefined) {
      await this.invitations.revoke(id, this.now())
    }
  }

  async roleOf(tenantId: string, userId: string): Promise<TeamRole | null> {
    return (await this.memberships.find(tenantId, userId))?.role ?? null
  }

  /** True when the user holds `required` or a higher-ranked role in the team. */
  async can(tenantId: string, userId: string, required: TeamRole): Promise<boolean> {
    const role = await this.roleOf(tenantId, userId)
    return role !== null && this.rankOf(role) >= this.rankOf(required)
  }

  async changeRole(tenantId: string, userId: string, role: TeamRole): Promise<Membership> {
    const current = await this.memberships.find(tenantId, userId)
    if (!current) throw new NotATeamMemberError()
    // Snapshot before setRole — the store may mutate `current` in place.
    const previousRole = current.role
    const membership: Membership = { ...current, role }
    if (previousRole !== role && previousRole === OWNER) await this.assertNotLastOwner(tenantId, userId)

    await this.memberships.setRole(tenantId, userId, role)
    if (this.access && previousRole !== role) {
      await this.access.removeRole(userId, previousRole, tenantId)
      await this.access.assignRole(userId, role, tenantId)
    }
    await this.hooks?.emit('team:role_changed', { membership })
    return membership
  }

  async removeMember(tenantId: string, userId: string): Promise<void> {
    const current = await this.memberships.find(tenantId, userId)
    if (!current) return
    if (current.role === OWNER) await this.assertNotLastOwner(tenantId, userId)

    await this.memberships.remove(tenantId, userId)
    await this.access?.removeRole(userId, current.role, tenantId)
    await this.hooks?.emit('team:member_removed', { tenantId, userId })
  }

  private async assertNotLastOwner(tenantId: string, exceptUserId: string): Promise<void> {
    const owners = (await this.memberships.list(tenantId)).filter(
      (m) => m.role === OWNER && m.userId !== exceptUserId,
    )
    if (owners.length === 0) throw new LastOwnerError()
  }
}
