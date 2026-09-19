import { createToken, ctx, definePlugin, BasaltError, type Container, ensureMetadata } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { Comments, type CommentsOptions } from './comments.js'
import type { Comment } from './store.js'

declare module '@basaltkit/core' {
  interface BasaltHooks {
    'comment:created': { comment: Comment }
    'comment:updated': { comment: Comment }
    'comment:deleted': { tenantId: string; id: string; resourceType: string; resourceId: string }
    'comment:resolved': { comment: Comment }
    'comment:reopened': { comment: Comment }
    /** One per mentioned user — wire to notifications. */
    'comment:mentioned': { comment: Comment; userId: string }
  }
}

export const COMMENTS = createToken<Comments>('comments')

export type CommentsPluginOptions = Omit<CommentsOptions, 'hooks'>

export function commentsPlugin(options: CommentsPluginOptions = {}) {
  return definePlugin({
    name: 'basalt:comments',
    register({ container, hooks }) {
      // 'tenancy:active' is tenancyPlugin's marker: how a generic package
      // learns the app is multi-tenant without importing @basaltkit/tenancy.
      const metadata = ensureMetadata(container)
      container.singleton(
        COMMENTS,
        () => new Comments({ ...options, hooks }, () => metadata.get('tenancy:active').length > 0),
      )
    },
  })
}

class CommentForbiddenError extends BasaltError {
  readonly status = 403
  constructor() {
    super('COMMENT_FORBIDDEN', 'You are not allowed to do that with this comment.')
  }
}
class UserRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REQUIRED', 'Authentication required.')
  }
}

const comments = () => (ctx().container as Container).get(COMMENTS)
const currentUser = (): CommentRouteUser => {
  // `user` is set by @basaltkit/auth; read it without a hard dependency on it.
  const user = (ctx() as unknown as { user?: CommentRouteUser }).user
  if (!user?.id) throw new UserRequiredError()
  return user
}

/** What a caller is trying to do through {@link commentRoutes}. */
export type CommentAction = 'list' | 'create' | 'edit' | 'delete' | 'resolve' | 'reopen'

/** The authenticated user a route runs as (`ctx().user`). */
export interface CommentRouteUser {
  id: string
  [key: string]: unknown
}

/** The resource a thread hangs off, plus the comment for per-comment actions. */
export interface CommentTarget {
  resourceType: string
  resourceId: string
  /** Present for `edit`, `delete`, `resolve` and `reopen`. */
  comment?: Comment
}

export interface CommentRoutesOptions {
  /**
   * Decides whether `user` may perform `action` on `target`. Replaces the
   * default policy — compose with {@link defaultCommentPolicy} to keep it.
   * Use it to tie a thread to the access rules of the resource it discusses
   * (a confidential matter's comments are as confidential as the matter).
   */
  authorize?: (action: CommentAction, target: CommentTarget, user: CommentRouteUser) => boolean | Promise<boolean>
}

/**
 * The policy used when `authorize` is not given: any authenticated user of the
 * tenant may read a thread and post to it; only a comment's author may edit,
 * delete, resolve or reopen it.
 */
export function defaultCommentPolicy(action: CommentAction, target: CommentTarget, user: CommentRouteUser): boolean {
  if (action === 'list' || action === 'create') return true
  return target.comment !== undefined && target.comment.authorId === user.id
}

/**
 * REST routes for the current tenant's comments, all requiring a logged-in
 * user. The author is taken from `ctx().user`. By default editing, deleting,
 * resolving and reopening are restricted to the comment's author; pass
 * `authorize` to apply your own per-resource policy.
 */
export function commentRoutes(options: CommentRoutesOptions = {}): BasaltRoute[] {
  const resource = z.object({ resourceType: z.string().min(1), resourceId: z.string().min(1) })
  const policy = options.authorize ?? defaultCommentPolicy
  const assertAllowed = async (action: CommentAction, target: CommentTarget): Promise<void> => {
    if ((await policy(action, target, currentUser())) !== true) throw new CommentForbiddenError()
  }
  /** Loads the comment and checks `action` on it; a missing one is refused like a forbidden one. */
  const assertOnComment = async (id: string, action: CommentAction): Promise<void> => {
    currentUser()
    const comment = await comments().get(id)
    if (!comment) throw new CommentForbiddenError()
    await assertAllowed(action, { resourceType: comment.resourceType, resourceId: comment.resourceId, comment })
  }

  return [
    route({
      method: 'GET',
      url: '/comments',
      meta: { auth: true },
      query: resource,
      async handler({ query }) {
        await assertAllowed('list', { resourceType: query.resourceType, resourceId: query.resourceId })
        return comments().on(query.resourceType, query.resourceId).tree()
      },
    }),
    route({
      method: 'POST',
      url: '/comments',
      meta: { auth: true },
      body: resource.extend({ body: z.string().min(1), parentId: z.string().optional() }),
      async handler({ body, reply }) {
        await assertAllowed('create', { resourceType: body.resourceType, resourceId: body.resourceId })
        const created = await comments()
          .on(body.resourceType, body.resourceId)
          .add({ authorId: currentUser().id, body: body.body, ...(body.parentId ? { parentId: body.parentId } : {}) })
        return reply.code(201).send(created)
      },
    }),
    route({
      method: 'PATCH',
      url: '/comments/:id',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      body: z.object({ body: z.string().min(1) }),
      async handler({ params, body }) {
        await assertOnComment(params.id, 'edit')
        return comments().edit(params.id, body.body)
      },
    }),
    route({
      method: 'DELETE',
      url: '/comments/:id',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        await assertOnComment(params.id, 'delete')
        await comments().remove(params.id)
        return reply.code(204).send()
      },
    }),
    route({
      method: 'POST',
      url: '/comments/:id/resolve',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params }) {
        await assertOnComment(params.id, 'resolve')
        return comments().resolve(params.id, currentUser().id)
      },
    }),
    route({
      method: 'POST',
      url: '/comments/:id/reopen',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params }) {
        await assertOnComment(params.id, 'reopen')
        return comments().reopen(params.id)
      },
    }),
  ]
}
