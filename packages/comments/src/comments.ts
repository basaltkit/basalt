import { randomUUID } from 'node:crypto'
import { BasaltError, tryCtx, type HookBus } from '@basaltkit/core'
import {
  MemoryCommentStore,
  type Comment,
  type CommentPatch,
  type CommentRevision,
  type CommentStore,
} from './store.js'

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
 * A tenant id equal to {@link SINGLE_TENANT_SCOPE}. That string is the store
 * key of a single-tenant app's comments, so a tenant carrying it would read,
 * edit and delete them. The default tenancy grammar can never produce it; a
 * custom one that does must pick another id.
 */
export class CommentTenantReservedError extends BasaltError {
  readonly status = 400
  constructor() {
    super('COMMENT_TENANT_RESERVED', `"${SINGLE_TENANT_SCOPE}" is reserved for single-tenant comments and cannot be a tenant id.`)
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

/** Editing is refused once `editWindowMs` has passed since the comment was posted. */
export class CommentEditWindowClosedError extends BasaltError {
  readonly status = 409
  constructor() {
    super('COMMENT_EDIT_WINDOW_CLOSED', 'This comment can no longer be edited.')
  }
}

/** `anchor` is not a plain JSON object of at most {@link MAX_ANCHOR_BYTES}. */
export class CommentAnchorInvalidError extends BasaltError {
  readonly status = 400
  constructor(reason: string) {
    super('COMMENT_ANCHOR_INVALID', `Invalid comment anchor: ${reason}.`)
  }
}

/** `revisions: true` was set on a store that cannot keep them. */
export class CommentRevisionsUnsupportedError extends BasaltError {
  constructor() {
    super(
      'COMMENT_REVISIONS_UNSUPPORTED',
      '`revisions: true` needs a CommentStore with `addRevision` and `revisions` ' +
        '(MemoryCommentStore, SqliteCommentStore and PrismaCommentStore have them).',
    )
  }
}

/**
 * Default `mentionPattern`: `@id` not preceded by a word character, `.`, `+`
 * or `-`, so the domain of `ana@example.com` is not read as a mention.
 */
export const DEFAULT_MENTION_PATTERN = /(?<![\w.+-])@([\w-]+)/g

/**
 * An explicit, delimited mention syntax — `@{user-id}` — for ids that contain
 * characters the default pattern stops at (dots, `@`, UUIDs with braces in the
 * UI). Pass it as `mentionPattern`.
 */
export const DELIMITED_MENTION_PATTERN = /@\{([^{}\s]+)\}/g

/** Largest `anchor`, as UTF-8 JSON. */
export const MAX_ANCHOR_BYTES = 4096

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
 *
 * A sentinel no tenant id can equal: `@` is outside `@basaltkit/tenancy`'s
 * grammar, and a context or explicit tenant carrying it is refused with
 * {@link CommentTenantReservedError}. It used to be `'default'` — a perfectly
 * valid tenant id, so a tenant named `default` read, edited and deleted the
 * single-tenant comments. Rows written under `'default'` by a single-tenant app
 * must be re-keyed once (see the changelog for the migration).
 */
export const SINGLE_TENANT_SCOPE = '@single'

export interface CommentsOptions {
  store?: CommentStore
  hooks?: HookBus
  /**
   * Regex (with the `g` flag) whose first capture group is a mentioned user id.
   * Default {@link DEFAULT_MENTION_PATTERN}; see also {@link DELIMITED_MENTION_PATTERN}.
   */
  mentionPattern?: RegExp
  /** Longest body accepted, in characters. Default {@link DEFAULT_MAX_COMMENT_LENGTH}. */
  maxBodyLength?: number
  /**
   * Most distinct `@mentions` one comment may carry — each one emits a
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
  /**
   * What `remove()` does. `'hard'` (the default) deletes the row. `'soft'`
   * keeps it with `deletedAt`/`deletedBy`/`deleteReason` set: threads keep
   * their shape, and `list()`/`tree()` return it as a tombstone (empty body,
   * no mentions). A soft-deleted comment can no longer be edited, resolved or
   * reopened.
   */
  deletion?: 'hard' | 'soft'
  /**
   * How long after posting a comment may still be edited, in ms. Past it
   * `edit()` throws {@link CommentEditWindowClosedError} (409). Default: no limit.
   */
  editWindowMs?: number
  /**
   * Keep every previous body: `edit()` records the old one before replacing it,
   * and `revisions(id)` lists them. Needs a store with `addRevision` and
   * `revisions`; without them construction throws
   * {@link CommentRevisionsUnsupportedError}.
   */
  revisions?: boolean
  now?: () => number
}

export interface AddCommentInput {
  authorId: string
  body: string
  parentId?: string
  /** Where in the resource the comment points (JSON object, at most 4 KB). */
  anchor?: Record<string, unknown>
}

/** Who acts, for the hook payloads. Default: `ctx().user.id` when there is one. */
export interface CommentActorOptions {
  tenantId?: string
  actorId?: string
}

export interface RemoveCommentOptions extends CommentActorOptions {
  /** Recorded as `deletedBy` on a soft delete. Default: the actor. */
  by?: string
  /** Recorded as `deleteReason` on a soft delete. */
  reason?: string
}

/** The tenant id (legacy positional argument) or the options object. */
type TenantOr<T> = string | T | undefined

const asOptions = <T extends CommentActorOptions>(value: TenantOr<T>): T =>
  (typeof value === 'string' ? { tenantId: value } : (value ?? {})) as T

/** Everything scoped to one resource (`resourceType`:`resourceId`) of a tenant. */
export interface ResourceComments {
  add(input: AddCommentInput): Promise<Comment>
  list(): Promise<Comment[]>
  tree(): Promise<CommentNode[]>
}

/** What a soft-deleted comment looks like in a listing: its place, not its content. */
const tombstone = (comment: Comment): Comment => {
  if (comment.deletedAt === undefined) return comment
  return { ...comment, body: '', mentions: [] }
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
 * Per-resource comment threads with `@mentions` and resolve/reopen, scoped by
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
  private readonly deletion: 'hard' | 'soft'
  private readonly editWindowMs: number | undefined
  private readonly keepRevisions: boolean
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
    this.mentionPattern = options.mentionPattern ?? DEFAULT_MENTION_PATTERN
    this.maxBodyLength = options.maxBodyLength ?? DEFAULT_MAX_COMMENT_LENGTH
    this.maxMentions = options.maxMentions ?? DEFAULT_MAX_MENTIONS
    this.resolveMentions = options.resolveMentions
    this.deletion = options.deletion ?? 'hard'
    this.editWindowMs = options.editWindowMs
    this.keepRevisions = options.revisions === true
    if (this.keepRevisions) assertRevisionStore(this.store)
    this.now = options.now ?? Date.now
  }

  on(resourceType: string, resourceId: string, tenantId?: string): ResourceComments {
    const tenant = this.tenant(tenantId)
    return {
      add: (input) => this.add(tenant, resourceType, resourceId, input),
      list: async () => (await this.store.list(tenant, resourceType, resourceId)).map(tombstone),
      tree: async () => buildTree((await this.store.list(tenant, resourceType, resourceId)).map(tombstone)),
    }
  }

  /** One comment as stored — a soft-deleted one included, with its body and `deletedAt`. */
  get(id: string, tenantId?: string): Promise<Comment | null> {
    return this.store.find(this.tenant(tenantId), id)
  }

  /**
   * Replaces the body (re-extracting mentions). Refused with 404 for a
   * soft-deleted comment and with 409 once `editWindowMs` has passed. With
   * `revisions` on, the previous body is recorded first.
   */
  async edit(id: string, body: string, tenantIdOrOptions?: TenantOr<CommentActorOptions>): Promise<Comment> {
    const options = asOptions(tenantIdOrOptions)
    const tenant = this.tenant(options.tenantId)
    const current = await this.store.find(tenant, id)
    if (!current || current.deletedAt !== undefined) throw new CommentNotFoundError()
    if (this.editWindowMs !== undefined && this.now() - current.createdAt > this.editWindowMs) {
      throw new CommentEditWindowClosedError()
    }
    const mentions = await this.mentions(body, tenant)
    const actorId = actor(options.actorId)
    const at = this.now()
    if (this.keepRevisions) {
      await this.store.addRevision!({
        id: randomUUID(),
        tenantId: tenant,
        commentId: id,
        body: current.body,
        at,
        ...(actorId !== undefined ? { by: actorId } : {}),
      })
    }
    const updated = await this.store.update(tenant, id, { body, mentions, editedAt: at })
    await this.hooks?.emit('comment:updated', { comment: updated!, ...withActor(actorId) })
    return updated!
  }

  /** A comment's previous bodies, oldest first (`revisions: true`). */
  async revisions(id: string, tenantId?: string): Promise<CommentRevision[]> {
    if (!this.keepRevisions) throw new CommentRevisionsUnsupportedError()
    return this.store.revisions!(this.tenant(tenantId), id)
  }

  /**
   * Deletes a comment — or, with `deletion: 'soft'`, marks it deleted
   * (`deletedAt`, `deletedBy`, `deleteReason`) and keeps it as a tombstone.
   * A missing or already deleted comment is a no-op.
   */
  async remove(id: string, tenantIdOrOptions?: TenantOr<RemoveCommentOptions>): Promise<void> {
    const options = asOptions(tenantIdOrOptions)
    const tenant = this.tenant(options.tenantId)
    const comment = await this.store.find(tenant, id)
    if (!comment || comment.deletedAt !== undefined) return
    const actorId = actor(options.actorId ?? options.by)
    const soft = this.deletion === 'soft'
    if (soft) {
      const by = options.by ?? actorId
      await this.store.update(tenant, id, {
        deletedAt: this.now(),
        ...(by !== undefined ? { deletedBy: by } : {}),
        ...(options.reason !== undefined ? { deleteReason: options.reason } : {}),
      })
    } else {
      await this.store.delete(tenant, id)
    }
    await this.hooks?.emit('comment:deleted', {
      tenantId: tenant,
      id,
      resourceType: comment.resourceType,
      resourceId: comment.resourceId,
      soft,
      ...withActor(actorId),
    })
  }

  async resolve(id: string, resolvedBy: string, tenantId?: string): Promise<Comment> {
    const comment = await this.mutate(id, { resolvedAt: this.now(), resolvedBy }, tenantId)
    await this.hooks?.emit('comment:resolved', { comment, actorId: resolvedBy })
    return comment
  }

  async reopen(id: string, tenantIdOrOptions?: TenantOr<CommentActorOptions>): Promise<Comment> {
    const options = asOptions(tenantIdOrOptions)
    const comment = await this.mutate(id, { resolvedAt: undefined, resolvedBy: undefined }, options.tenantId)
    await this.hooks?.emit('comment:reopened', { comment, ...withActor(actor(options.actorId)) })
    return comment
  }

  private async add(
    tenantId: string,
    resourceType: string,
    resourceId: string,
    input: AddCommentInput,
  ): Promise<Comment> {
    const mentions = await this.mentions(input.body, tenantId)
    if (input.anchor !== undefined) assertAnchor(input.anchor)
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
      ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
    }
    await this.store.create(comment)
    await this.hooks?.emit('comment:created', { comment, actorId: input.authorId })
    for (const userId of mentions) {
      await this.hooks?.emit('comment:mentioned', { comment, userId, actorId: input.authorId })
    }
    return comment
  }

  private async mutate(id: string, patch: CommentPatch, tenantId?: string): Promise<Comment> {
    const tenant = this.tenant(tenantId)
    const current = await this.store.find(tenant, id)
    if (!current || current.deletedAt !== undefined) throw new CommentNotFoundError()
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
      return assertNotReserved(ambient)
    }
    if (explicit) return assertNotReserved(explicit)
    if (this.tenancyActive()) throw new CommentTenantRequiredError()
    return SINGLE_TENANT_SCOPE
  }
}

/** The acting user: the explicit id, else the request's `ctx().user.id`. */
function actor(explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit
  return (tryCtx()?.['user'] as { id?: string } | undefined)?.id
}

const withActor = (actorId: string | undefined): { actorId?: string } =>
  actorId !== undefined ? { actorId } : {}

function assertRevisionStore(store: CommentStore): void {
  if (typeof store.addRevision !== 'function' || typeof store.revisions !== 'function') {
    throw new CommentRevisionsUnsupportedError()
  }
}

/** A plain JSON object of at most {@link MAX_ANCHOR_BYTES} once encoded. */
function assertAnchor(anchor: unknown): void {
  if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) {
    throw new CommentAnchorInvalidError('it must be a JSON object')
  }
  let json: string
  try {
    json = JSON.stringify(anchor)
  } catch {
    throw new CommentAnchorInvalidError('it must be JSON-serializable')
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_ANCHOR_BYTES) {
    throw new CommentAnchorInvalidError(`it may be at most ${MAX_ANCHOR_BYTES} bytes as JSON`)
  }
}

/** Exported for `commentsPlugin`, which checks the store at registration. */
export { assertRevisionStore }

function assertNotReserved(tenantId: string): string {
  if (tenantId === SINGLE_TENANT_SCOPE) throw new CommentTenantReservedError()
  return tenantId
}
