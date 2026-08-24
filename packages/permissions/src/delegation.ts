import { randomUUID } from 'node:crypto'

/**
 * Temporary permissions and delegation on top of the standing role/permission
 * grants. A **temporary grant** gives a user extra permissions until an expiry
 * (break-glass access, a time-boxed task). A **delegation** lets one user act
 * with a subset of another's permissions for a while — bounded, at check time,
 * to what the delegator can actually do (so a delegation never grants more than
 * the delegator has, and delegations don't chain).
 */

export interface TemporaryGrant {
  id: string
  userId: string
  permissions: string[]
  scope: string
  /** Epoch ms after which the grant is inert. */
  expiresAt: number
  grantedBy?: string
  reason?: string
}

export interface TemporaryGrantStore {
  add(grant: TemporaryGrant): Promise<void>
  /** Non-expired grants for a user in a scope. */
  activeFor(userId: string, scope: string, now: number): Promise<TemporaryGrant[]>
  revoke(id: string): Promise<void>
  all(): Promise<TemporaryGrant[]>
}

export class MemoryTemporaryGrantStore implements TemporaryGrantStore {
  private readonly grants = new Map<string, TemporaryGrant>()
  async add(grant: TemporaryGrant): Promise<void> {
    this.grants.set(grant.id, { ...grant })
  }
  async activeFor(userId: string, scope: string, now: number): Promise<TemporaryGrant[]> {
    return [...this.grants.values()].filter(
      (g) => g.userId === userId && g.scope === scope && g.expiresAt > now,
    )
  }
  async revoke(id: string): Promise<void> {
    this.grants.delete(id)
  }
  async all(): Promise<TemporaryGrant[]> {
    return [...this.grants.values()].map((g) => ({ ...g }))
  }
}

export interface Delegation {
  id: string
  /** The user whose authority is being lent. */
  fromUserId: string
  /** The user who may act with it. */
  toUserId: string
  /** Permission patterns delegated; `'*'` = everything the delegator can do. */
  permissions: string[]
  scope: string
  createdAt: number
  /** Epoch ms; omit for an open-ended delegation. */
  expiresAt?: number
}

export interface DelegationStore {
  add(delegation: Delegation): Promise<void>
  /** Non-expired delegations granted TO a user in a scope. */
  activeTo(toUserId: string, scope: string, now: number): Promise<Delegation[]>
  /** Non-expired delegations granted BY a user in a scope. */
  activeFrom(fromUserId: string, scope: string, now: number): Promise<Delegation[]>
  revoke(id: string): Promise<void>
  all(): Promise<Delegation[]>
}

export class MemoryDelegationStore implements DelegationStore {
  private readonly delegations = new Map<string, Delegation>()
  private live(d: Delegation, now: number): boolean {
    return d.expiresAt === undefined || d.expiresAt > now
  }
  async add(delegation: Delegation): Promise<void> {
    this.delegations.set(delegation.id, { ...delegation })
  }
  async activeTo(toUserId: string, scope: string, now: number): Promise<Delegation[]> {
    return [...this.delegations.values()].filter(
      (d) => d.toUserId === toUserId && d.scope === scope && this.live(d, now),
    )
  }
  async activeFrom(fromUserId: string, scope: string, now: number): Promise<Delegation[]> {
    return [...this.delegations.values()].filter(
      (d) => d.fromUserId === fromUserId && d.scope === scope && this.live(d, now),
    )
  }
  async revoke(id: string): Promise<void> {
    this.delegations.delete(id)
  }
  async all(): Promise<Delegation[]> {
    return [...this.delegations.values()].map((d) => ({ ...d }))
  }
}

export const newDelegationId = (): string => randomUUID()
