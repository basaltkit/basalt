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

/**
 * An explicit `tenantId` named a different tenant than the one the call runs
 * in. The context tenant is authoritative; an argument may narrow to it, never
 * widen past it.
 */
export class CommentTenantMismatchError extends BasaltError {
  readonly status = 403
  constructor() {
    super('COMMENT_TENANT_MISMATCH', 'The tenantId does not match the current tenant.')
  }
}

/**
 * `parentId` does not name a comment of the same thread. A reply may only hang
 * off a comment of the resource it is posted on: linking it to another thread
 * would sidestep that thread's authorization (a caller allowed on an open
 * resource replying "into" a restricted one, notifying its author).
 */
export class CommentParentNotFoundError extends BasaltError {
  readonly status = 400
  constructor() {
    super('COMMENT_PARENT_NOT_FOUND', 'The parent comment does not exist in this thread.')
  }
}

export class CommentTooLongError extends BasaltError {
  readonly status = 400
  constructor(max: number) {
    super('COMMENT_TOO_LONG', `A comment may be at most ${max} characters.`)
  }
}

export class CommentMentionLimitError extends BasaltError {
  readonly status = 400
  constructor(max: number) {
    super('COMMENT_TOO_MANY_MENTIONS', `A comment may mention at most ${max} users.`)
  }
}

/** Default `maxBodyLength`. */
export const DEFAULT_MAX_COMMENT_LENGTH = 10_000
/** Default `maxMentions`. */
export const DEFAULT_MAX_MENTIONS = 50

/** A comment plus its nested replies. */
export interface CommentNode extends Comment {
  replies: CommentNode[]
}

/**
 * Store key every comment is filed under when the app has no tenancy at all.
 * The {@link CommentStore} contract is tenant-keyed, so a single-tenant app
 * still needs one stable key — it just shouldn't have to invent it.
 */
export const SINGLE_TENANT_SCOPE = 'default'

export interface CommentsOptions {
  store?: CommentStore
  hooks?: HookBus
  /** Regex whose first capture group is a mentioned user id. Default `@([\w-]+)`. */
  mentionPattern?: RegExp
  /** Longest body accepted, in characters. Default {@link DEFAULT_MAX_COMMENT_LENGTH}. */
  maxBodyLength?: number
  /**
   * Most distinct @mentions one comment may carry — each one emits a
   * `comment:mentioned` hook (a notification). Default {@link DEFAULT_MAX_MENTIONS}.
   */
  maxMentions?: number
  /**
   * Filters the mentioned ids down to the users that may be mentioned — typically
   * the members of `tenantId`. Ids it drops are neither stored nor notified.
   *
   * Without it every `@id` in the body is taken at face value, so a mention can
   * address a user of another tenant: wire it whenever `comment:mentioned`
   * reaches a real notification channel.
   */
  resolveMentions?: (ids: string[], tenantId: string) => string[] | Promise<string[]>
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
  private readonly maxBodyLength: number
  private readonly maxMentions: number
  private readonly resolveMentions: CommentsOptions['resolveMentions']
  private readonly now: () => number

  constructor(
    options: CommentsOptions = {},
    /**
     * Whether the host app registered `@basaltkit/tenancy`. `commentsPlugin`
     * wires this to the container's `'tenancy:active'` metadata marker — a
     * signal, not an import, so this generic package never depends on the
     * opt-in SaaS layer. Defaults to `false` (single-tenant).
     */
    private readonly tenancyActive: () => boolean = () => false,
  ) {
    this.store = options.store ?? new MemoryCommentStore()
    this.hooks = options.hooks
    this.mentionPattern = options.mentionPattern ?? /@([\w-]+)/g
    this.maxBodyLength = options.maxBodyLength ?? DEFAULT_MAX_COMMENT_LENGTH
    this.maxMentions = options.maxMentions ?? DEFAULT_MAX_MENTIONS
    this.resolveMentions = options.resolveMentions
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
    const mentions = await this.mentions(body, tenant)
    const updated = await this.store.update(tenant, id, { body, mentions, editedAt: this.now() })
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
    const mentions = await this.mentions(input.body, tenantId)
    if (input.parentId !== undefined) {
      const parent = await this.store.find(tenantId, input.parentId)
      if (!parent || parent.resourceType !== resourceType || parent.resourceId !== resourceId) {
        throw new CommentParentNotFoundError()
      }
    }
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

  /**
   * Validates the body and extracts its mentions. Bounded on both counts: an
   * unbounded body with one `@id` per few bytes turned a single request into
   * hundreds of thousands of `comment:mentioned` notifications.
   */
  private async mentions(body: string, tenantId: string): Promise<string[]> {
    if (body.length > this.maxBodyLength) throw new CommentTooLongError(this.maxBodyLength)
    const ids = new Set<string>()
    for (const match of body.matchAll(this.mentionPattern)) {
      if (!match[1]) continue
      ids.add(match[1])
      if (ids.size > this.maxMentions) throw new CommentMentionLimitError(this.maxMentions)
    }
    const found = [...ids]
    if (!this.resolveMentions || found.length === 0) return found
    const allowed = new Set(await this.resolveMentions(found, tenantId))
    return found.filter((id) => allowed.has(id))
  }

  /**
   * The tenant a call is scoped to.
   *
   * With `@basaltkit/tenancy` registered an unresolvable tenant is an error: an
   * unscoped read or write would cross tenants. Without it there is no tenant
   * dimension, so every comment shares {@link SINGLE_TENANT_SCOPE}.
   */
  private tenant(explicit?: string): string {
    // The context tenant wins: an explicit value is only honoured when it
    // agrees with it, or when there is no context tenant (jobs, CLI, scripts).
    const ambient = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (ambient) {
      if (explicit !== undefined && explicit !== ambient) throw new CommentTenantMismatchError()
      return ambient
    }
    if (explicit) return explicit
    if (this.tenancyActive()) throw new CommentTenantRequiredError()
    return SINGLE_TENANT_SCOPE
  }
}
