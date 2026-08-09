import { randomUUID } from 'node:crypto'
import { BasaltError, tryCtx, type HookBus } from '@basaltkit/core'
import { MemoryCommentStore, type Comment, type CommentPatch, type CommentStore } from './store.js'

export class CommentNotFoundError extends BasaltError {
  readonly status = 404
  constructor() {
    super('COMMENT_NOT_FOUND', 'Comment not found.')
  }
}

export class CommentTenantRequiredError extends BasaltError {
  readonly status = 400
  constructor() {
    super('COMMENT_TENANT_REQUIRED', 'A tenant is required — pass tenantId or run inside a tenant context.')
  }
}

/** A comment plus its nested replies. */
export interface CommentNode extends Comment {
  replies: CommentNode[]
}

export interface CommentsOptions {
  store?: CommentStore
  hooks?: HookBus
  /** Regex whose first capture group is a mentioned user id. Default `@([\w-]+)`. */
  mentionPattern?: RegExp
  now?: () => number
}

export interface AddCommentInput {
  authorId: string
  body: string
  parentId?: string
}

/** Everything scoped to one resource (`resourceType`:`resourceId`) of a tenant. */
export interface ResourceComments {
  add(input: AddCommentInput): Promise<Comment>
  list(): Promise<Comment[]>
  tree(): Promise<CommentNode[]>
}

const buildTree = (comments: Comment[]): CommentNode[] => {
  const nodes = new Map<string, CommentNode>(comments.map((c) => [c.id, { ...c, replies: [] }]))
  const roots: CommentNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.replies.push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * Per-resource comment threads with @mentions and resolve/reopen, scoped by
 * tenant. Emits hooks (`comment:created`, `comment:mentioned`, …) so live
 * updates (@basaltkit/realtime) and notifications wire up without coupling.
 */
export class Comments {
  private readonly store: CommentStore
  private readonly hooks: HookBus | undefined
  private readonly mentionPattern: RegExp
  private readonly now: () => number

  constructor(options: CommentsOptions = {}) {
    this.store = options.store ?? new MemoryCommentStore()
    this.hooks = options.hooks
    this.mentionPattern = options.mentionPattern ?? /@([\w-]+)/g
    this.now = options.now ?? Date.now
  }

  on(resourceType: string, resourceId: string, tenantId?: string): ResourceComments {
    const tenant = this.tenant(tenantId)
    return {
      add: (input) => this.add(tenant, resourceType, resourceId, input),
      list: () => this.store.list(tenant, resourceType, resourceId),
      tree: async () => buildTree(await this.store.list(tenant, resourceType, resourceId)),
    }
  }

  get(id: string, tenantId?: string): Promise<Comment | null> {
    return this.store.find(this.tenant(tenantId), id)
  }

  async edit(id: string, body: string, tenantId?: string): Promise<Comment> {
    const tenant = this.tenant(tenantId)
    if (!(await this.store.find(tenant, id))) throw new CommentNotFoundError()
    const updated = await this.store.update(tenant, id, { body, mentions: this.mentions(body), editedAt: this.now() })
    await this.hooks?.emit('comment:updated', { comment: updated! })
    return updated!
  }

  async remove(id: string, tenantId?: string): Promise<void> {
    const tenant = this.tenant(tenantId)
    const comment = await this.store.find(tenant, id)
    if (!comment) return
    await this.store.delete(tenant, id)
    await this.hooks?.emit('comment:deleted', {
      tenantId: tenant,
      id,
      resourceType: comment.resourceType,
      resourceId: comment.resourceId,
    })
  }

  async resolve(id: string, resolvedBy: string, tenantId?: string): Promise<Comment> {
    const comment = await this.mutate(id, { resolvedAt: this.now(), resolvedBy }, tenantId)
    await this.hooks?.emit('comment:resolved', { comment })
    return comment
  }

  async reopen(id: string, tenantId?: string): Promise<Comment> {
    const comment = await this.mutate(id, { resolvedAt: undefined, resolvedBy: undefined }, tenantId)
    await this.hooks?.emit('comment:reopened', { comment })
    return comment
  }

  private async add(
    tenantId: string,
    resourceType: string,
    resourceId: string,
    input: AddCommentInput,
  ): Promise<Comment> {
    const mentions = this.mentions(input.body)
    const comment: Comment = {
      id: randomUUID(),
      tenantId,
      resourceType,
      resourceId,
      authorId: input.authorId,
      body: input.body,
      mentions,
      createdAt: this.now(),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    }
    await this.store.create(comment)
    await this.hooks?.emit('comment:created', { comment })
    for (const userId of mentions) await this.hooks?.emit('comment:mentioned', { comment, userId })
    return comment
  }

  private async mutate(id: string, patch: CommentPatch, tenantId?: string): Promise<Comment> {
    const tenant = this.tenant(tenantId)
    if (!(await this.store.find(tenant, id))) throw new CommentNotFoundError()
    return (await this.store.update(tenant, id, patch))!
  }

  private mentions(body: string): string[] {
    const ids = new Set<string>()
    for (const match of body.matchAll(this.mentionPattern)) if (match[1]) ids.add(match[1])
    return [...ids]
  }

  private tenant(explicit?: string): string {
    const id = explicit ?? (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (!id) throw new CommentTenantRequiredError()
    return id
  }
}
