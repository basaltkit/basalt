import type { Comment } from '@basaltkit/comments'
import { describe, expect, it } from 'vitest'
import { ColumnLengthError, type PrismaCommentsClient, prismaCommentsStore } from '../src/index.js'

/** A fake that records every write; the guard must stop a write before it gets here. */
function recordingClient(): { client: PrismaCommentsClient; writes: string[] } {
  const writes: string[] = []
  const client: PrismaCommentsClient = {
    comment: {
      async findUnique() {
        return null
      },
      async findMany() {
        return []
      },
      async create({ data }) {
        writes.push('create')
        return data
      },
      async updateMany() {
        writes.push('updateMany')
        return { count: 1 }
      },
      async deleteMany() {
        return { count: 0 }
      },
    },
  }
  return { client, writes }
}

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: 'c1',
  tenantId: 't1',
  resourceType: 'invoice',
  resourceId: 'i1',
  authorId: 'u1',
  body: 'Looks good',
  mentions: [],
  createdAt: 1,
  ...over,
})

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it("'mysql' stores a long body (TEXT) and refuses a >191 resourceId", async () => {
    const { client, writes } = recordingClient()
    const { store } = prismaCommentsStore(client, { columnLimits: 'mysql' })
    await store.create(comment({ body: 'b'.repeat(3000) }))
    await expect(store.create(comment({ id: 'c2', resourceId: 'r'.repeat(192) }))).rejects.toMatchObject({
      column: 'Comment.resourceId',
    })
    expect(writes).toEqual(['create'])
  })

  it('an edit whose body exceeds the column is refused, not saved cut short', async () => {
    const { client, writes } = recordingClient()
    const { store } = prismaCommentsStore(client, { columnLimits: { Comment: { body: 191 } } })
    await expect(store.update('t1', 'c1', { body: 'b'.repeat(192) })).rejects.toBeInstanceOf(ColumnLengthError)
    expect(writes).toEqual([])
  })

  it('unset: no check (PostgreSQL / SQLite)', async () => {
    const { client, writes } = recordingClient()
    await prismaCommentsStore(client).store.create(comment({ resourceId: 'r'.repeat(500) }))
    expect(writes).toEqual(['create'])
  })
})
