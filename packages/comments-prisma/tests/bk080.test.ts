import { Comments } from '@basaltkit/comments'
import { describe, expect, it } from 'vitest'
import { ColumnLengthError, PrismaCommentStore, type PrismaCommentsClient } from '../src/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

function fakeClient(withRevisions = true): { client: PrismaCommentsClient; created: Row[] } {
  const rows = new Map<string, Row>()
  const revisions: Row[] = []
  const created: Row[] = []
  const k = (t: string, i: string) => JSON.stringify([t, i])
  const client: PrismaCommentsClient = {
    comment: {
      async findUnique({ where }) {
        const { tenantId, id } = where.tenantId_id
        return (rows.get(k(tenantId, id)) ?? null) as any
      },
      async findMany({ where }) {
        return [...rows.values()].filter(
          (r) => r.tenantId === where.tenantId && r.resourceType === where.resourceType && r.resourceId === where.resourceId,
        ) as any
      },
      async create({ data }) {
        created.push(data)
        rows.set(k(data.tenantId, data.id), { ...data })
        return data
      },
      async updateMany({ where, data }) {
        const row = rows.get(k(where.tenantId, where.id))
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
      async deleteMany({ where }) {
        return { count: rows.delete(k(where.tenantId, where.id)) ? 1 : 0 }
      },
    },
    ...(withRevisions
      ? {
          commentRevision: {
            async create({ data }: any) {
              revisions.push({ ...data })
              return data
            },
            async findMany({ where }: any) {
              return revisions
                .filter((r) => r.tenantId === where.tenantId && r.commentId === where.commentId)
                .sort((a, b) => a.at.getTime() - b.at.getTime()) as any
            },
            async deleteMany({ where }: any) {
              const before = revisions.length
              revisions.splice(0, revisions.length, ...revisions.filter((r) => !(r.tenantId === where.tenantId && r.commentId === where.commentId)))
              return { count: before - revisions.length }
            },
          },
        }
      : {}),
  }
  return { client, created }
}

describe('BK-080 · PrismaCommentStore', () => {
  it('writes the new columns only when used', async () => {
    const { client, created } = fakeClient()
    await new Comments({ store: new PrismaCommentStore(client) }).on('doc', '1', 'acme').add({ authorId: 'u1', body: 'x' })
    for (const key of ['anchor', 'deletedAt', 'deletedBy', 'deleteReason']) expect(Object.keys(created[0]!)).not.toContain(key)
  })

  it('round-trips anchor and soft delete', async () => {
    const { client } = fakeClient()
    const store = new PrismaCommentStore(client)
    const comments = new Comments({ store, deletion: 'soft', now: () => 7 })
    const c = await comments.on('doc', '1', 'acme').add({ authorId: 'u1', body: 'x', anchor: { cell: 'B2' } })
    await comments.remove(c.id, { tenantId: 'acme', by: 'mod', reason: 'dup' })
    expect(await store.find('acme', c.id)).toMatchObject({ anchor: { cell: 'B2' }, deletedAt: 7, deletedBy: 'mod', deleteReason: 'dup' })
  })

  it('records and lists revisions; a client without the model fails with a clear error', async () => {
    const { client } = fakeClient()
    let now = 1
    const comments = new Comments({ store: new PrismaCommentStore(client), revisions: true, now: () => now })
    const c = await comments.on('doc', '1', 'acme').add({ authorId: 'u1', body: 'v1' })
    now = 2
    await comments.edit(c.id, 'v2', { tenantId: 'acme', actorId: 'u9' })
    expect(await comments.revisions(c.id, 'acme')).toEqual([
      { id: expect.any(String), tenantId: 'acme', commentId: c.id, body: 'v1', at: 2, by: 'u9' },
    ])

    const bare = new PrismaCommentStore(fakeClient(false).client)
    await expect(bare.revisions('acme', 'x')).rejects.toThrow(/CommentRevision model/)
  })

  it('checks the new columns against the mysql limits', async () => {
    const { client } = fakeClient()
    const comments = new Comments({ store: new PrismaCommentStore(client, { columnLimits: 'mysql' }), deletion: 'soft' })
    const c = await comments.on('doc', '1', 'acme').add({ authorId: 'u1', body: 'x' })
    await expect(comments.remove(c.id, { tenantId: 'acme', by: 'm'.repeat(300) })).rejects.toBeInstanceOf(ColumnLengthError)
  })
})
