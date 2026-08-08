import { beforeEach, describe, expect, it } from 'vitest'
import { PrismaCommentStore, type PrismaCommentsClient, prismaCommentsStore } from '../src/index.js'

interface CRow {
  tenantId: string; id: string; resourceType: string; resourceId: string; parentId: string | null
  authorId: string; body: string; mentions: string[]; resolvedAt: Date | null; resolvedBy: string | null
  editedAt: Date | null; createdAt: Date
}

function makeFakeClient(): PrismaCommentsClient {
  const rows = new Map<string, CRow>()
  const k = (t: string, i: string): string => `${t}::${i}`
  return {
    comment: {
      async findUnique({ where }) {
        const { tenantId, id } = where.tenantId_id
        return rows.get(k(tenantId, id)) ?? null
      },
      async findMany({ where, orderBy }) {
        let out = [...rows.values()].filter(
          (r) => r.tenantId === where.tenantId && r.resourceType === where.resourceType && r.resourceId === where.resourceId,
        )
        if (orderBy?.createdAt === 'asc') out = out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        return out
      },
      async create({ data }) {
        const row = { ...data } as CRow
        rows.set(k(row.tenantId, row.id), row)
        return row
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
  }
}

const base = { tenantId: 'acme', resourceType: 'issue', resourceId: '1', authorId: 'u1', mentions: ['u2'] }

let client: PrismaCommentsClient
beforeEach(() => {
  client = makeFakeClient()
})

describe('PrismaCommentStore', () => {
  it('creates, finds, lists and deletes', async () => {
    const store = new PrismaCommentStore(client)
    await store.create({ id: 'c1', body: 'first', createdAt: 1, ...base })
    await store.create({ id: 'c2', body: 'reply', createdAt: 2, parentId: 'c1', ...base })
    await store.create({ id: 'c3', body: 'other', createdAt: 3, ...base, resourceId: '2' })

    const c1 = await store.find('acme', 'c1')
    expect(c1?.body).toBe('first')
    expect(c1?.createdAt).toBe(1)
    expect(c1?.parentId).toBeUndefined()
    expect((await store.find('acme', 'c2'))?.parentId).toBe('c1')
    expect(await store.find('acme', 'missing')).toBeNull()

    expect((await store.list('acme', 'issue', '1')).map((c) => c.id)).toEqual(['c1', 'c2'])
    await store.delete('acme', 'c1')
    expect(await store.find('acme', 'c1')).toBeNull()

    // a comment created already-resolved/edited round-trips those timestamps
    await store.create({ id: 'c9', body: 'r', createdAt: 4, resolvedAt: 400, resolvedBy: 'u9', editedAt: 401, ...base, resourceId: '9' })
    const c9 = await store.find('acme', 'c9')
    expect(c9?.resolvedAt).toBe(400)
    expect(c9?.resolvedBy).toBe('u9')
    expect(c9?.editedAt).toBe(401)
  })

  it('edits, resolves and reopens', async () => {
    const store = new PrismaCommentStore(client)
    await store.create({ id: 'c1', body: 'first', createdAt: 1, ...base })

    const edited = await store.update('acme', 'c1', { body: 'edited', mentions: ['u3'], editedAt: 50 })
    expect(edited?.body).toBe('edited')
    expect(edited?.mentions).toEqual(['u3'])
    expect(edited?.editedAt).toBe(50)

    const resolved = await store.update('acme', 'c1', { resolvedAt: 100, resolvedBy: 'u9' })
    expect(resolved?.resolvedAt).toBe(100)

    const reopened = await store.update('acme', 'c1', { resolvedAt: undefined, resolvedBy: undefined })
    expect(reopened?.resolvedAt).toBeUndefined()
    expect(reopened?.resolvedBy).toBeUndefined()

    const clear = { mentions: undefined, editedAt: undefined } as unknown as Parameters<typeof store.update>[2]
    const cleared = await store.update('acme', 'c1', clear)
    expect(cleared?.mentions).toEqual([])
    expect(cleared?.editedAt).toBeUndefined()

    expect(await store.update('acme', 'ghost', { body: 'x' })).toBeNull()
    expect((await store.update('acme', 'c1', {}))?.id).toBe('c1')
  })
})

describe('prismaCommentsStore', () => {
  it('bundles the store named for commentsPlugin', () => {
    expect(prismaCommentsStore(client).store).toBeInstanceOf(PrismaCommentStore)
  })
})
