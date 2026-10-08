import { describe, expect, it } from 'vitest'
import { createApp, HookBus, runWithContext } from '@basaltkit/core'
import {
  CommentAnchorInvalidError,
  CommentEditWindowClosedError,
  CommentNotFoundError,
  CommentRevisionsUnsupportedError,
  Comments,
  DELIMITED_MENTION_PATTERN,
  MemoryCommentStore,
  commentsPlugin,
  type CommentStore,
} from '../src/index.js'

/**
 * BK-080 · mention pattern, actorId on hooks, anchors, opt-in soft delete,
 * edit window and revisions.
 */

const thread = (comments: Comments) => comments.on('doc', '12', 'acme')

describe('BK-080 · mentions', () => {
  it('does not read the domain of an email address as a mention', async () => {
    const c = await thread(new Comments()).add({ authorId: 'u1', body: 'mail ana@example.com, ping @rui and (@eva-2)' })
    expect(c.mentions).toEqual(['rui', 'eva-2'])
  })

  it('ignores a.b@c, x+y@d and word@ prefixes but keeps a leading mention', async () => {
    const c = await thread(new Comments()).add({ authorId: 'u1', body: '@ana first; a.b@c x+y@d w-@z' })
    expect(c.mentions).toEqual(['ana'])
  })

  it('DELIMITED_MENTION_PATTERN reads @{id} with any non-space id', async () => {
    const comments = new Comments({ mentionPattern: DELIMITED_MENTION_PATTERN })
    const c = await thread(comments).add({ authorId: 'u1', body: 'cc @{ana.silva@firm.ao} and @{u-9}, not @rui' })
    expect(c.mentions).toEqual(['ana.silva@firm.ao', 'u-9'])
  })

  it('rejects unresolved mentions when resolveMentions throws', async () => {
    const comments = new Comments({
      resolveMentions: (ids) => {
        const unknown = ids.filter((id) => id !== 'rui')
        if (unknown.length > 0) throw new Error(`Unknown users: ${unknown.join(', ')}`)
        return ids
      },
    })
    await expect(thread(comments).add({ authorId: 'u1', body: '@ghost hi' })).rejects.toThrow('Unknown users: ghost')
    expect((await thread(comments).add({ authorId: 'u1', body: '@rui hi' })).mentions).toEqual(['rui'])
  })
})

describe('BK-080 · actorId on hook payloads', () => {
  it('carries the author, the resolver, an explicit actor, or ctx().user', async () => {
    const hooks = new HookBus()
    const seen: Record<string, unknown> = {}
    for (const e of ['comment:created', 'comment:mentioned', 'comment:updated', 'comment:resolved', 'comment:reopened', 'comment:deleted'] as const) {
      hooks.on(e, (p) => {
        seen[e] = (p as { actorId?: string }).actorId
      })
    }
    const comments = new Comments({ hooks })
    const c = await thread(comments).add({ authorId: 'u1', body: 'hi @u2' })
    await comments.edit(c.id, 'edited', { tenantId: 'acme', actorId: 'u3' })
    await comments.resolve(c.id, 'u4', 'acme')
    await runWithContext({ user: { id: 'u5' } } as never, () => comments.reopen(c.id, 'acme'))
    await runWithContext({ user: { id: 'u6' } } as never, () => comments.remove(c.id, 'acme'))
    expect(seen).toEqual({
      'comment:created': 'u1',
      'comment:mentioned': 'u1',
      'comment:updated': 'u3',
      'comment:resolved': 'u4',
      'comment:reopened': 'u5',
      'comment:deleted': 'u6',
    })
  })

  it('omits actorId when there is no actor', async () => {
    const hooks = new HookBus()
    let payload: Record<string, unknown> = {}
    hooks.on('comment:updated', (p) => {
      payload = p as Record<string, unknown>
    })
    const comments = new Comments({ hooks })
    const c = await thread(comments).add({ authorId: 'u1', body: 'x' })
    await comments.edit(c.id, 'y', 'acme')
    expect('actorId' in payload).toBe(false)
  })
})

describe('BK-080 · anchor', () => {
  it('stores a JSON object anchor', async () => {
    const anchor = { page: 3, rect: [10, 20, 30, 40] }
    const c = await thread(new Comments()).add({ authorId: 'u1', body: 'here', anchor })
    expect(c.anchor).toEqual(anchor)
  })

  it('refuses arrays, non-JSON and anchors over 4 KB', async () => {
    const comments = new Comments()
    await expect(thread(comments).add({ authorId: 'u1', body: 'x', anchor: [1] as never })).rejects.toBeInstanceOf(CommentAnchorInvalidError)
    await expect(thread(comments).add({ authorId: 'u1', body: 'x', anchor: { n: 1n } as never })).rejects.toBeInstanceOf(CommentAnchorInvalidError)
    await expect(thread(comments).add({ authorId: 'u1', body: 'x', anchor: { s: 'x'.repeat(5000) } })).rejects.toBeInstanceOf(CommentAnchorInvalidError)
  })
})

describe('BK-080 · soft delete', () => {
  it('stays hard by default', async () => {
    const comments = new Comments()
    const c = await thread(comments).add({ authorId: 'u1', body: 'x' })
    await comments.remove(c.id, 'acme')
    expect(await comments.get(c.id, 'acme')).toBeNull()
  })

  it('keeps a tombstone that preserves the thread shape', async () => {
    const hooks = new HookBus()
    let deleted: Record<string, unknown> = {}
    hooks.on('comment:deleted', (p) => {
      deleted = p as Record<string, unknown>
    })
    const comments = new Comments({ deletion: 'soft', hooks, now: () => 1000 })
    const root = await thread(comments).add({ authorId: 'u1', body: 'secret @u2' })
    await thread(comments).add({ authorId: 'u2', body: 'reply', parentId: root.id })

    await comments.remove(root.id, { tenantId: 'acme', by: 'mod', reason: 'spam' })
    expect(deleted).toMatchObject({ id: root.id, soft: true, actorId: 'mod' })

    const tree = await thread(comments).tree()
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ id: root.id, body: '', mentions: [], deletedAt: 1000, deletedBy: 'mod', deleteReason: 'spam' })
    expect(tree[0]!.replies.map((r) => r.body)).toEqual(['reply'])

    // get() returns the stored record (for moderation); edits are refused.
    expect((await comments.get(root.id, 'acme'))!.body).toBe('secret @u2')
    await expect(comments.edit(root.id, 'x', 'acme')).rejects.toBeInstanceOf(CommentNotFoundError)
    await expect(comments.resolve(root.id, 'u1', 'acme')).rejects.toBeInstanceOf(CommentNotFoundError)

    // Removing again is a no-op (no second hook).
    deleted = {}
    await comments.remove(root.id, 'acme')
    expect(deleted).toEqual({})
  })
})

describe('BK-080 · edit window', () => {
  it('refuses edits with 409 once the window has passed', async () => {
    let now = 0
    const comments = new Comments({ editWindowMs: 60_000, now: () => now })
    const c = await thread(comments).add({ authorId: 'u1', body: 'x' })
    now = 60_000
    await comments.edit(c.id, 'still ok', 'acme')
    now = 60_001
    const error = await comments.edit(c.id, 'too late', 'acme').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CommentEditWindowClosedError)
    expect((error as { status: number }).status).toBe(409)
  })
})

describe('BK-080 · revisions', () => {
  it('records each previous body before replacing it', async () => {
    let now = 10
    const comments = new Comments({ revisions: true, now: () => now })
    const c = await thread(comments).add({ authorId: 'u1', body: 'v1' })
    now = 20
    await comments.edit(c.id, 'v2', { tenantId: 'acme', actorId: 'u1' })
    now = 30
    await comments.edit(c.id, 'v3', 'acme')
    const revisions = await comments.revisions(c.id, 'acme')
    expect(revisions.map((r) => [r.body, r.at, r.by])).toEqual([
      ['v1', 20, 'u1'],
      ['v2', 30, undefined],
    ])
    expect((await comments.get(c.id, 'acme'))!.body).toBe('v3')
  })

  it('keeps revisions per tenant', async () => {
    const store = new MemoryCommentStore()
    const comments = new Comments({ revisions: true, store })
    const c = await thread(comments).add({ authorId: 'u1', body: 'v1' })
    await comments.edit(c.id, 'v2', 'acme')
    expect(await store.revisions('globex', c.id)).toEqual([])
  })

  it('fails at construction and at plugin boot on a store without revision support', async () => {
    const inner = new MemoryCommentStore()
    const bare: CommentStore = {
      create: (c) => inner.create(c),
      find: (t, i) => inner.find(t, i),
      list: (t, r, i) => inner.list(t, r, i),
      update: (t, i, p) => inner.update(t, i, p),
      delete: (t, i) => inner.delete(t, i),
    }
    expect(() => new Comments({ revisions: true, store: bare })).toThrow(CommentRevisionsUnsupportedError)
    await expect(createApp({ plugins: [commentsPlugin({ revisions: true, store: bare })] }).boot()).rejects.toBeInstanceOf(
      CommentRevisionsUnsupportedError,
    )
    await expect(new Comments().revisions('x', 'acme')).rejects.toBeInstanceOf(CommentRevisionsUnsupportedError)
  })
})
