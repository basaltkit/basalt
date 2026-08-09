import { describe, expect, it } from 'vitest'
import { PrismaOutboxStore, type PrismaEventsClient, prismaOutboxStore } from '../src/index.js'

interface Row {
  id: string
  event: string
  payload: string | null
  tenantId: string | null
  createdAt: Date
  attempts: number
  publishedAt: Date | null
  lastError: string | null
}

// In-memory fake of the Prisma delegate surface — the injectable-client pattern.
// Mirrors just enough Prisma semantics: upsert, findMany (where/orderBy/take),
// updateMany (with the `increment` operator).
function makeFakeClient(): PrismaEventsClient {
  const rows = new Map<string, Row>()

  return {
    outboxEntry: {
      async upsert({ where, create, update }) {
        const existing = rows.get(where.id)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row: Row = {
          id: create.id,
          event: create.event,
          payload: create.payload ?? null,
          tenantId: create.tenantId ?? null,
          createdAt: create.createdAt,
          attempts: create.attempts ?? 0,
          publishedAt: null,
          lastError: null,
        }
        rows.set(row.id, row)
        return row
      },
      async findMany({ where, take }) {
        let list = [...rows.values()]
        if (where?.publishedAt === null) list = list.filter((r) => r.publishedAt === null)
        if (where?.attempts?.lt !== undefined) list = list.filter((r) => r.attempts < where.attempts.lt)
        // the store always asks for orderBy [{ createdAt: 'asc' }, { id: 'asc' }]
        list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        if (take !== undefined) list = list.slice(0, take)
        return list
      },
      async updateMany({ where, data }) {
        const row = rows.get(where.id)
        if (!row) return { count: 0 }
        if (data.publishedAt !== undefined) row.publishedAt = data.publishedAt
        if (data.lastError !== undefined) row.lastError = data.lastError
        if (data.attempts?.increment !== undefined) row.attempts += data.attempts.increment
        return { count: 1 }
      },
    },
  }
}

describe('PrismaOutboxStore', () => {
  it('enqueues (auto id, attempts 0) and round-trips the payload', async () => {
    const store = new PrismaOutboxStore(makeFakeClient())
    const entry = await store.enqueue({ event: 'order.created', payload: { id: 42 }, createdAt: 10 })
    expect(entry.id).toMatch(/[0-9a-f-]{36}/)
    expect(entry.attempts).toBe(0)

    const [stored] = await store.all()
    expect(stored?.event).toBe('order.created')
    expect(stored?.payload).toEqual({ id: 42 })
    expect(stored?.createdAt).toBe(10)
  })

  it('keeps tenantId only when given', async () => {
    const store = new PrismaOutboxStore(makeFakeClient())
    await store.enqueue({ id: 't', event: 'e', payload: 1, tenantId: 'acme', createdAt: 1 })
    await store.enqueue({ id: 'n', event: 'e', payload: 1, createdAt: 2 })
    const all = await store.all()
    expect(all.find((e) => e.id === 't')?.tenantId).toBe('acme')
    expect('tenantId' in (all.find((e) => e.id === 'n') ?? {})).toBe(false)
  })

  it('pending: unpublished, below the ceiling, oldest first, limited', async () => {
    const store = new PrismaOutboxStore(makeFakeClient())
    await store.enqueue({ id: 'a', event: 'e', payload: 1, createdAt: 30 })
    await store.enqueue({ id: 'b', event: 'e', payload: 1, createdAt: 10 })
    await store.enqueue({ id: 'c', event: 'e', payload: 1, createdAt: 20 })

    expect((await store.pending(10, 5)).map((e) => e.id)).toEqual(['b', 'c', 'a'])
    expect((await store.pending(2, 5)).map((e) => e.id)).toEqual(['b', 'c'])

    await store.markPublished('b', 99)
    expect((await store.pending(10, 5)).map((e) => e.id)).toEqual(['c', 'a'])
    expect((await store.all()).find((e) => e.id === 'b')?.publishedAt).toBe(99)
  })

  it('markFailed increments attempts and drops the entry past the ceiling', async () => {
    const store = new PrismaOutboxStore(makeFakeClient())
    await store.enqueue({ id: 'x', event: 'e', payload: 1, createdAt: 1 })

    await store.markFailed('x', 'boom')
    await store.markFailed('x', 'again')
    const x = (await store.all())[0]
    expect(x?.attempts).toBe(2)
    expect(x?.lastError).toBe('again')

    expect((await store.pending(10, 3)).map((e) => e.id)).toEqual(['x'])
    expect((await store.pending(10, 2)).length).toBe(0)
  })

  it('markPublished on a missing id is a no-op (no throw)', async () => {
    const store = new PrismaOutboxStore(makeFakeClient())
    await expect(store.markPublished('ghost', 1)).resolves.toBeUndefined()
  })

  it('re-enqueuing the same id replaces the entry (attempts reset)', async () => {
    const store = new PrismaOutboxStore(makeFakeClient())
    await store.enqueue({ id: 'x', event: 'e', payload: 1, createdAt: 1 })
    await store.markFailed('x', 'boom')
    await store.enqueue({ id: 'x', event: 'e', payload: 2, createdAt: 5 })

    const x = (await store.all())[0]
    expect(x?.attempts).toBe(0)
    expect(x?.lastError).toBeUndefined()
    expect(x?.payload).toBe(2)
  })
})

describe('prismaOutboxStore', () => {
  it('returns a store ready for outboxPlugin({ store })', () => {
    expect(prismaOutboxStore(makeFakeClient()).store).toBeInstanceOf(PrismaOutboxStore)
  })

  it('fails fast when the client lacks the OutboxEntry model', () => {
    expect(() => prismaOutboxStore({} as unknown as PrismaEventsClient)).toThrow(
      /has no `outboxEntry` model/,
    )
  })
})
