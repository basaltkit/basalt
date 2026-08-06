/** A user's role name within a team (tenant). Free-form; ranked by the service. */
export type TeamRole = string

/** A user's membership of one team (tenant). */
export interface Membership {
  tenantId: string
  userId: string
  role: TeamRole
  createdAt: number
}

/** An outstanding invitation to join a team. */
export interface Invitation {
  id: string
  tenantId: string
  email: string
  role: TeamRole
  /** Secret carried in the emailed link. A DB store may persist a hash instead. */
  token: string
  invitedBy?: string
  expiresAt: number
  acceptedAt?: number
  revokedAt?: number
}

/** What listings expose — never the token. */
export type PublicInvitation = Omit<Invitation, 'token'>

export interface MembershipStore {
  add(membership: Membership): Promise<void>
  find(tenantId: string, userId: string): Promise<Membership | null>
  list(tenantId: string): Promise<Membership[]>
  setRole(tenantId: string, userId: string, role: TeamRole): Promise<void>
  remove(tenantId: string, userId: string): Promise<void>
}

export class MemoryMembershipStore implements MembershipStore {
  private readonly records = new Map<string, Membership>()
  private key(tenantId: string, userId: string): string {
    return `${tenantId}::${userId}`
  }

  async add(membership: Membership): Promise<void> {
    this.records.set(this.key(membership.tenantId, membership.userId), membership)
  }
  async find(tenantId: string, userId: string): Promise<Membership | null> {
    return this.records.get(this.key(tenantId, userId)) ?? null
  }
  async list(tenantId: string): Promise<Membership[]> {
    const out: Membership[] = []
    for (const m of this.records.values()) if (m.tenantId === tenantId) out.push(m)
    return out
  }
  async setRole(tenantId: string, userId: string, role: TeamRole): Promise<void> {
    const m = this.records.get(this.key(tenantId, userId))
    if (m) m.role = role
  }
  async remove(tenantId: string, userId: string): Promise<void> {
    this.records.delete(this.key(tenantId, userId))
  }
}

export interface InvitationStore {
  create(invitation: Invitation): Promise<void>
  findByToken(token: string): Promise<Invitation | null>
  findById(id: string): Promise<Invitation | null>
  /** Pending (not accepted, not revoked, not expired-at read time is caller's job). */
  listPending(tenantId: string): Promise<Invitation[]>
  findPending(tenantId: string, email: string): Promise<Invitation | null>
  markAccepted(id: string, at: number): Promise<void>
  revoke(id: string, at: number): Promise<void>
}

export class MemoryInvitationStore implements InvitationStore {
  private readonly records = new Map<string, Invitation>()

  private pending(i: Invitation): boolean {
    return i.acceptedAt === undefined && i.revokedAt === undefined
  }

  async create(invitation: Invitation): Promise<void> {
    this.records.set(invitation.id, invitation)
  }
  async findByToken(token: string): Promise<Invitation | null> {
    for (const i of this.records.values()) if (i.token === token) return i
    return null
  }
  async findById(id: string): Promise<Invitation | null> {
    return this.records.get(id) ?? null
  }
  async listPending(tenantId: string): Promise<Invitation[]> {
    const out: Invitation[] = []
    for (const i of this.records.values()) if (i.tenantId === tenantId && this.pending(i)) out.push(i)
    return out
  }
  async findPending(tenantId: string, email: string): Promise<Invitation | null> {
    for (const i of this.records.values()) {
      if (i.tenantId === tenantId && i.email === email && this.pending(i)) return i
    }
    return null
  }
  async markAccepted(id: string, at: number): Promise<void> {
    const i = this.records.get(id)
    if (i) i.acceptedAt = at
  }
  async revoke(id: string, at: number): Promise<void> {
    const i = this.records.get(id)
    if (i) i.revokedAt = at
  }
}
