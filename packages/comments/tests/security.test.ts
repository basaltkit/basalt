import { describe, expect, it } from 'vitest'
import { Container, HookBus, runWithContext } from '@basaltkit/core'
import {
  COMMENTS,
  CommentMentionLimitError,
  CommentTenantMismatchError,
  CommentTooLongError,
  Comments,
  MemoryCommentStore,
  commentRoutes,
  type CommentRoutesOptions,
} from '../src/index.js'
import type { Comment } from '../src/index.js'

describe('F61 · comment bodies and mention fan-out are bounded', () => {
  it('refuses a body over the default 10 000 characters, on add and on edit', async () => {
    const comments = new Comments()
    await expect(comments.on('note', '1').add({ authorId: 'u1', body: 'x'.repeat(10_001) })).rejects.toBeInstanceOf(
      CommentTooLongError,
    )
    const ok = await comments.on('note', '1').add({ authorId: 'u1', body: 'x'.repeat(10_000) })
    await expect(comments.edit(ok.id, 'y'.repeat(10_001))).rejects.toBeInstanceOf(CommentTooLongError)
  })

  it('refuses more than 50 distinct mentions and emits nothing for the refused comment', async () => {
    const hooks = new HookBus()
    let emissions = 0
    hooks.on('comment:mentioned', () => {
      emissions++
    })
    const comments = new Comments({ hooks })
    const tooMany = Array.from({ length: 51 }, (_, i) => `@u${i}`).join(' ')
    await expect(comments.on('note', '1').add({ authorId: 'a', body: tooMany })).rejects.toBeInstanceOf(
      CommentMentionLimitError,
    )
    // The mention cap holds on its own, even with the length cap lifted.
    const lifted = new Comments({ hooks, maxBodyLength: Number.POSITIVE_INFINITY })
    const flood = Array.from({ length: 50_000 }, (_, i) => `@u${i}`).join(' ')
    await expect(lifted.on('note', '1').add({ authorId: 'a', body: flood })).rejects.toBeInstanceOf(
      CommentMentionLimitError,
    )
    expect(emissions).toBe(0)

    const fifty = Array.from({ length: 50 }, (_, i) => `@u${i}`).join(' ')
    await comments.on('note', '1').add({ authorId: 'a', body: fifty })
    expect(emissions).toBe(50)
  })

  it('resolveMentions keeps only the ids the app vouches for (e.g. tenant members)', async () => {
    const hooks = new HookBus()
    const notified: string[] = []
    hooks.on('comment:mentioned', (p) => {
      notified.push((p as { userId: string }).userId)
    })
    const seen: Array<[string[], string]> = []
    const comments = new Comments({
      hooks,
      resolveMentions: (ids, tenantId) => {
        seen.push([ids, tenantId])
        return ids.filter((id) => id === 'member')
      },
    })
    const c = await comments.on('note', '1', 'acme').add({ authorId: 'a', body: 'hi @member and @outsider' })
    expect(c.mentions).toEqual(['member'])
    expect(notified).toEqual(['member'])
    expect(seen).toEqual([[['member', 'outsider'], 'acme']])
  })
})

describe('F59 · an explicit tenantId never widens past the context tenant', () => {
  it('refuses a tenantId that differs from the ambient tenant', async () => {
    const comments = new Comments({}, () => true)
    const globex = await comments.on('note', '1', 'globex').add({ authorId: 'u9', body: 'secret' })
    // `on()`/`get()` resolve the tenant synchronously, so wrap to observe a rejection.
    const inAcme = <T>(fn: () => Promise<T>) => runWithContext({ tenant: { id: 'acme' } } as never, async () => fn())

    await expect(inAcme(() => comments.on('note', '1', 'globex').list())).rejects.toBeInstanceOf(CommentTenantMismatchError)
    await expect(inAcme(() => comments.get(globex.id, 'globex'))).rejects.toBeInstanceOf(CommentTenantMismatchError)
    await expect(inAcme(() => comments.remove(globex.id, 'globex'))).rejects.toBeInstanceOf(CommentTenantMismatchError)
    await expect(inAcme(() => comments.edit(globex.id, 'x', 'globex'))).rejects.toBeInstanceOf(CommentTenantMismatchError)
    await expect(inAcme(() => comments.resolve(globex.id, 'u1', 'globex'))).rejects.toBeInstanceOf(CommentTenantMismatchError)
    await expect(
      inAcme(() => comments.on('note', '1', 'globex').add({ authorId: 'u1', body: 'planted' })),
    ).rejects.toBeInstanceOf(CommentTenantMismatchError)
    expect(await comments.on('note', '1', 'globex').list()).toHaveLength(1)
    // Naming the ambient tenant is fine.
    expect(await inAcme(() => comments.on('note', '1', 'acme').list())).toEqual([])
  })
})

function fakeReply() {
  const state: { status?: number; payload?: unknown } = {}
  const reply = {
    code(status: number) {
      state.status = status
      return reply
    },
    send(payload?: unknown) {
      state.payload = payload
      return reply
    },
  }
  return { reply, state }
}

function routesHarness(options?: CommentRoutesOptions & { hooks?: HookBus }) {
  const service = new Comments(options?.hooks ? { hooks: options.hooks } : {})
  const container = new Container()
  container.singleton(COMMENTS, () => service)
  const routes = commentRoutes(options)
  const call = (userId: string, method: string, url: string, args: Record<string, unknown> = {}) => {
    const { reply, state } = fakeReply()
    return runWithContext({ container, user: { id: userId } } as never, () =>
      Promise.resolve(routes.find((r) => r.method === method && r.url === url)!.handler({ reply, ...args } as never)),
    ).then(
      (out) => ({ out, state, error: undefined as unknown }),
      (error: unknown) => ({ out: undefined, state, error }),
    )
  }
  return { service, call }
}

describe('F61 · commentRoutes() authorize resolve/reopen and support a per-resource hook', () => {
  it('by default only the author can resolve or reopen a comment', async () => {
    const { service, call } = routesHarness()
    const c = await service.on('note', '1').add({ authorId: 'ada', body: 'hi' })

    const resolved = await call('mallory', 'POST', '/comments/:id/resolve', { params: { id: c.id } })
    expect(resolved.error).toMatchObject({ status: 403 })
    expect((await service.get(c.id))?.resolvedAt).toBeUndefined()

    await service.resolve(c.id, 'ada')
    const reopened = await call('mallory', 'POST', '/comments/:id/reopen', { params: { id: c.id } })
    expect(reopened.error).toMatchObject({ status: 403 })
    expect((await service.get(c.id))?.resolvedAt).toBeDefined()

    expect((await call('ada', 'POST', '/comments/:id/reopen', { params: { id: c.id } })).error).toBeUndefined()
  })

  it('an authorize hook is consulted for reads, writes and moderation', async () => {
    const calls: string[] = []
    const { service, call } = routesHarness({
      authorize: (action, target, user) => {
        calls.push(`${action}:${target.resourceType}/${target.resourceId}:${user.id}`)
        return target.resourceId !== 'restricted' && (action !== 'delete' || user.id === 'moderator')
      },
    })
    const c = await service.on('note', 'restricted').add({ authorId: 'ada', body: 'hidden' })
    const open = await service.on('note', 'open').add({ authorId: 'ada', body: 'visible' })

    const list = await call('bob', 'GET', '/comments', { query: { resourceType: 'note', resourceId: 'restricted' } })
    expect(list.error).toMatchObject({ status: 403 })
    const post = await call('bob', 'POST', '/comments', {
      body: { resourceType: 'note', resourceId: 'restricted', body: 'x' },
    })
    expect(post.error).toMatchObject({ status: 403 })
    expect((await call('bob', 'POST', '/comments/:id/resolve', { params: { id: c.id } })).error).toMatchObject({ status: 403 })

    // A moderator may delete someone else's comment when the hook says so.
    expect((await call('moderator', 'DELETE', '/comments/:id', { params: { id: open.id } })).state.status).toBe(204)
    expect(calls).toContain('list:note/restricted:bob')
    expect(calls).toContain('delete:note/open:moderator')
  })
})

describe('F61 · a reply cannot hang off a comment of another thread', () => {
  it('parentId must name a comment of the same resource (and tenant)', async () => {
    const created: Comment[] = []
    const hooks = new HookBus()
    hooks.on('comment:created', ({ comment }) => {
      created.push(comment)
    })
    const { service, call } = routesHarness({
      hooks,
      // A restricted thread only its assignee (ada) may read or post to.
      authorize: (_action, target, user) => target.resourceId !== 'restricted' || user.id === 'ada',
    })
    const secret = await service.on('note', 'restricted').add({ authorId: 'ada', body: 'hidden' })
    const other = await runWithContext({ tenant: { id: 'globex' } } as never, () =>
      service.on('note', 'open').add({ authorId: 'eve', body: 'globex' }),
    )
    created.length = 0

    // Bob is allowed on the open thread, and tries to reply into the restricted
    // one (or another tenant's comment, or one that does not exist) through it.
    for (const parentId of [secret.id, other.id, 'missing']) {
      const post = await call('bob', 'POST', '/comments', {
        body: { resourceType: 'note', resourceId: 'open', body: 'gotcha', parentId },
      })
      expect(post.error, parentId).toMatchObject({ status: 400, code: 'COMMENT_PARENT_NOT_FOUND' })
    }
    expect(created).toEqual([])

    // A reply within the same thread still works.
    const root = await service.on('note', 'open').add({ authorId: 'ada', body: 'root' })
    const reply = await call('bob', 'POST', '/comments', {
      body: { resourceType: 'note', resourceId: 'open', body: 'reply', parentId: root.id },
    })
    expect(reply.error).toBeUndefined()
  })
})

describe('MemoryCommentStore keys cannot collide across tenants', () => {
  it('a tenant id containing the separator does not reach another tenant comment', async () => {
    const store = new MemoryCommentStore()
    const comment: Comment = {
      id: 'uuid-1', tenantId: 'a b', resourceType: 'n', resourceId: '1', authorId: 'u', body: 'b', mentions: [], createdAt: 0,
    }
    await store.create(comment)
    expect(await store.find('a', 'b uuid-1')).toBeNull()
    expect(await store.find('a b', 'uuid-1')).not.toBeNull()
  })
})
