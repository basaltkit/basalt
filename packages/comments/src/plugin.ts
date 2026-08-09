import { createToken, ctx, definePlugin, BasaltError, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/fastify'
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
      container.singleton(COMMENTS, () => new Comments({ ...options, hooks }))
    },
  })
}

class CommentForbiddenError extends BasaltError {
  readonly status = 403
  constructor() {
    super('COMMENT_FORBIDDEN', 'You can only modify your own comments.')
  }
}
class UserRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REQUIRED', 'Authentication required.')
  }
}

const comments = () => (ctx().container as Container).get(COMMENTS)
const currentUser = (): string => {
  // `user` is set by @basaltkit/auth; read it without a hard dependency on it.
  const id = (ctx() as { user?: { id: string } }).user?.id
  if (!id) throw new UserRequiredError()
  return id
}
const assertAuthor = async (id: string): Promise<void> => {
  const comment = await comments().get(id)
  if (!comment || comment.authorId !== currentUser()) throw new CommentForbiddenError()
}

/**
 * REST routes for the current tenant's comments, all requiring a logged-in
 * user. The author is taken from `ctx().user`; editing and deleting are
 * restricted to the comment's author.
 */
export function commentRoutes(): BasaltRoute[] {
  const resource = z.object({ resourceType: z.string().min(1), resourceId: z.string().min(1) })

  return [
    route({
      method: 'GET',
      url: '/comments',
      meta: { auth: true },
      query: resource,
      async handler({ query }) {
        return comments().on(query.resourceType, query.resourceId).tree()
      },
    }),
    route({
      method: 'POST',
      url: '/comments',
      meta: { auth: true },
      body: resource.extend({ body: z.string().min(1), parentId: z.string().optional() }),
      async handler({ body, reply }) {
        const created = await comments()
          .on(body.resourceType, body.resourceId)
          .add({ authorId: currentUser(), body: body.body, ...(body.parentId ? { parentId: body.parentId } : {}) })
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
        await assertAuthor(params.id)
        return comments().edit(params.id, body.body)
      },
    }),
    route({
      method: 'DELETE',
      url: '/comments/:id',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        await assertAuthor(params.id)
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
        return comments().resolve(params.id, currentUser())
      },
    }),
    route({
      method: 'POST',
      url: '/comments/:id/reopen',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params }) {
        return comments().reopen(params.id)
      },
    }),
  ]
}
