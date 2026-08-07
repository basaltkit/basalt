/** A comment attached to a resource (`resourceType`:`resourceId`) within a tenant. */
export interface Comment {
  id: string
  tenantId: string
  resourceType: string
  resourceId: string
  /** Set when this comment is a reply to another. */
  parentId?: string
  authorId: string
  body: string
  /** User ids extracted from @mentions in the body. */
  mentions: string[]
  resolvedAt?: number
  resolvedBy?: string
  editedAt?: number
  createdAt: number
}

export interface CommentPatch {
  body?: string
  mentions?: string[]
  editedAt?: number
  /** `undefined` clears it (reopen). */
  resolvedAt?: number | undefined
  resolvedBy?: string | undefined
}

export interface CommentStore {
  create(comment: Comment): Promise<void>
  find(tenantId: string, id: string): Promise<Comment | null>
  /** Every comment on a resource (the whole thread), oldest first. */
  list(tenantId: string, resourceType: string, resourceId: string): Promise<Comment[]>
  update(tenantId: string, id: string, patch: CommentPatch): Promise<Comment | null>
  delete(tenantId: string, id: string): Promise<void>
}

export class MemoryCommentStore implements CommentStore {
  private readonly records = new Map<string, Comment>()
  private key(tenantId: string, id: string): string {
    return `${tenantId} ${id}`
  }

  async create(comment: Comment): Promise<void> {
    this.records.set(this.key(comment.tenantId, comment.id), comment)
  }
  async find(tenantId: string, id: string): Promise<Comment | null> {
    return this.records.get(this.key(tenantId, id)) ?? null
  }
  async list(tenantId: string, resourceType: string, resourceId: string): Promise<Comment[]> {
    const out: Comment[] = []
    for (const c of this.records.values()) {
      if (c.tenantId === tenantId && c.resourceType === resourceType && c.resourceId === resourceId) out.push(c)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }
  async update(tenantId: string, id: string, patch: CommentPatch): Promise<Comment | null> {
    const record = this.records.get(this.key(tenantId, id))
    if (!record) return null
    Object.assign(record, patch)
    return record
  }
  async delete(tenantId: string, id: string): Promise<void> {
    this.records.delete(this.key(tenantId, id))
  }
}
