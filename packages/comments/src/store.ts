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
  /** User ids extracted from `@mentions` in the body. */
  mentions: string[]
  resolvedAt?: number
  resolvedBy?: string
  editedAt?: number
  createdAt: number
  /**
   * Where in the resource the comment points — a page and region of a PDF, a
   * cell, a text range. Free-form JSON (at most 4 KB), stored as given.
   */
  anchor?: Record<string, unknown>
  /** Set by a soft delete (`deletion: 'soft'`). */
  deletedAt?: number
  deletedBy?: string
  deleteReason?: string
}

export interface CommentPatch {
  body?: string
  mentions?: string[]
  editedAt?: number
  /** `undefined` clears it (reopen). */
  resolvedAt?: number | undefined
  resolvedBy?: string | undefined
  deletedAt?: number
  deletedBy?: string | undefined
  deleteReason?: string | undefined
}

/** A previous body of a comment, recorded by `edit()` when `revisions` is on. */
export interface CommentRevision {
  id: string
  tenantId: string
  commentId: string
  /** The body as it was before the edit. */
  body: string
  /** When that body was replaced. */
  at: number
  /** Who replaced it, when known. */
  by?: string
}

export interface CommentStore {
  create(comment: Comment): Promise<void>
  find(tenantId: string, id: string): Promise<Comment | null>
  /** Every comment on a resource (the whole thread), oldest first. */
  list(tenantId: string, resourceType: string, resourceId: string): Promise<Comment[]>
  update(tenantId: string, id: string, patch: CommentPatch): Promise<Comment | null>
  delete(tenantId: string, id: string): Promise<void>
  /** Optional: stores a previous body. Required by `revisions: true`. */
  addRevision?(revision: CommentRevision): Promise<void>
  /** Optional: a comment's previous bodies, oldest first. Required by `revisions: true`. */
  revisions?(tenantId: string, commentId: string): Promise<CommentRevision[]>
}

export class MemoryCommentStore implements CommentStore {
  private readonly records = new Map<string, Comment>()
  private readonly history = new Map<string, CommentRevision[]>()
  // Tuple-encoded: a joined string lets a tenant id containing the separator
  // address another tenant's comment.
  private key(tenantId: string, id: string): string {
    return JSON.stringify([tenantId, id])
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
    this.history.delete(this.key(tenantId, id))
  }
  async addRevision(revision: CommentRevision): Promise<void> {
    const key = this.key(revision.tenantId, revision.commentId)
    ;(this.history.get(key) ?? this.history.set(key, []).get(key)!).push({ ...revision })
  }
  async revisions(tenantId: string, commentId: string): Promise<CommentRevision[]> {
    return (this.history.get(this.key(tenantId, commentId)) ?? []).map((r) => ({ ...r }))
  }
}
