import { DatabaseSync } from 'node:sqlite'
import { Comments } from '@basaltkit/comments'
import { describe, expect, it } from 'vitest'
import { migrate, openCommentsDatabase, SqliteCommentStore } from '../src/index.js'

describe('BK-080 · SqliteCommentStore', () => {
  it('round-trips an anchor and soft-delete fields', async () => {
    const store = new SqliteCommentStore(openCommentsDatabase())
    const comments = new Comments({ store, deletion: 'soft', now: () => 5 })
    const c = await comments.on('doc', '1', 'acme').add({ authorId: 'u1', body: 'hi', anchor: { page: 2 } })
    expect((await store.find('acme', c.id))?.anchor).toEqual({ page: 2 })

    await comments.remove(c.id, { tenantId: 'acme', by: 'mod', reason: 'spam' })
    expect(await store.find('acme', c.id)).toMatchObject({ body: 'hi', deletedAt: 5, deletedBy: 'mod', deleteReason: 'spam' })
    expect((await comments.on('doc', '1', 'acme').list())[0]).toMatchObject({ body: '', deletedAt: 5 })
  })

  it('keeps revisions per tenant, oldest first, and drops them with a hard delete', async () => {
    const store = new SqliteCommentStore(openCommentsDatabase())
    let now = 1
    const comments = new Comments({ store, revisions: true, now: () => now })
    const c = await comments.on('doc', '1', 'acme').add({ authorId: 'u1', body: 'v1' })
    now = 2
    await comments.edit(c.id, 'v2', { tenantId: 'acme', actorId: 'u1' })
    now = 3
    await comments.edit(c.id, 'v3', 'acme')
    expect((await comments.revisions(c.id, 'acme')).map((r) => [r.body, r.at, r.by])).toEqual([
      ['v1', 2, 'u1'],
      ['v2', 3, undefined],
    ])
    expect(await store.revisions('globex', c.id)).toEqual([])
    await comments.remove(c.id, 'acme')
    expect(await store.revisions('acme', c.id)).toEqual([])
  })

  it('migrates a database created before the new columns existed', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE comments (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
      parent_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL,
      resolved_at INTEGER, resolved_by TEXT, edited_at INTEGER, created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id))`)
    db.prepare(
      "INSERT INTO comments (tenant_id, id, resource_type, resource_id, author_id, body, mentions, created_at) VALUES ('acme', 'old', 'doc', '1', 'u1', 'b', '[]', 1)",
    ).run()
    migrate(db)
    const store = new SqliteCommentStore(db)
    expect(await store.find('acme', 'old')).toEqual({
      id: 'old', tenantId: 'acme', resourceType: 'doc', resourceId: '1', authorId: 'u1', body: 'b', mentions: [], createdAt: 1,
    })
    expect((await store.update('acme', 'old', { deletedAt: 9 }))?.deletedAt).toBe(9)
  })
})
