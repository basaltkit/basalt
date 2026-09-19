import { describe, expect, it } from 'vitest'
import { Outbox, type OutboxEntry } from '@basaltkit/events'
import { PrismaOutboxStore, prismaOutboxStore, type PrismaEventsClient } from '../src/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

/**
 * A fake Prisma client with just enough semantics for transactions and claims:
 * a generic `where` evaluator (null, lt/lte/in/notIn/not, OR/AND), atomic
 * `updateMany` (evaluate + write in one synchronous step, like a row-locking
 * UPDATE), and `$transaction(fn)` that buffers writes and applies them only on
 * commit — a throw rolls them back.
 */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c))
    if (key === 'AND') return (cond as Row[]).every((c) => matches(row, c))
    const value = row[key]
    if (cond === null) return value === null
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime()
    if (typeof cond !== 'object') return value === cond
    const cmp = (v: any) => (v instanceof Date ? v.getTime() : v)
    if ('in' in cond && !(cond.in as unknown[]).includes(value)) return false
    if ('notIn' in cond && (value === null || (cond.notIn as unknown[]).includes(value))) return false
    if ('not' in cond && (cond.not === null ? value === null : value === cond.not)) return false
    if ('lt' in cond && !(value !== null && cmp(value) < cmp(cond.lt))) return false
    if ('lte' in cond && !(value !== null && cmp(value) <= cmp(cond.lte))) return false
    return true
  })
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment
    else row[key] = value
  }
}

function makeDelegate(rows: Map<string, Row>, onWrite?: (op: () => void) => void) {
  const write = (op: () => void) => (onWrite ? onWrite(op) : op())
  const tick = () => new Promise((r) => setTimeout(r, 0)) // let other callers interleave
  return {
    async upsert({ where, create, update }: any) {
      await tick()
      write(() => {
        const existing = rows.get(where.id)
        if (existing) apply(existing, update)
        else rows.set(create.id, { publishedAt: null, lastError: null, lockedUntil: null, lockedBy: null, ...create })
      })
      return rows.get(where.id) ?? create
    },
    async findMany({ where, orderBy, take }: any = {}) {
      await tick()
      let list = [...rows.values()].filter((r) => matches(r, where))
      if (orderBy) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      if (take !== undefined) list = list.slice(0, take)
      return list.map((r) => ({ ...r }))
    },
    async updateMany({ where, data }: any) {
      await tick()
      let count = 0
      write(() => {
        for (const row of rows.values()) {
          if (matches(row, where)) {
            apply(row, data)
            count++
          }
        }
      })
      return { count }
    },
  }
}

function makeClient() {
  const rows = new Map<string, Row>()
  const client = {
    rows,
    outboxEntry: makeDelegate(rows),
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const pending: (() => void)[] = []
      const tx = { outboxEntry: makeDelegate(rows, (op) => pending.push(op)) }
      const result = await fn(tx) // a throw leaves `pending` unapplied: rolled back
      for (const op of pending) op()
      return result
    },
  }
  return client
}

describe('PrismaOutboxStore — enqueue in the caller\'s transaction', () => {
  it('writes through the tx client: committed with the transaction', async () => {
    const client = makeClient()
    const outbox = new Outbox(new PrismaOutboxStore(client as unknown as PrismaEventsClient))
    await client.$transaction(async (tx) => {
      await outbox.enqueue('order.paid', { id: 1 }, { tenantId: 'acme', tx })
    })
    const [entry] = await outbox['store'].all()
    expect(entry).toMatchObject({ event: 'order.paid', payload: { id: 1 }, tenantId: 'acme' })
  })

  it('a rolled-back transaction leaves no outbox entry', async () => {
    const client = makeClient()
    const store = new PrismaOutboxStore(client as unknown as PrismaEventsClient)
    const outbox = new Outbox(store)
    await expect(
      client.$transaction(async (tx) => {
        await outbox.enqueue('order.paid', { id: 1 }, { tx })
        throw new Error('business rule failed after the enqueue')
      }),
    ).rejects.toThrow('business rule failed')
    expect(await store.all()).toEqual([])
    expect((await outbox.flush(() => {})).published).toBe(0)
  })

  it('never falls back to the root client when a tx is given', async () => {
    const client = makeClient()
    client.outboxEntry.upsert = () => {
      throw new Error('root client used inside a transaction')
    }
    const store = new PrismaOutboxStore(client as unknown as PrismaEventsClient)
    await client.$transaction(async (tx) => {
      await store.enqueue({ event: 'e', payload: 1, createdAt: 1 }, { tx })
    })
    expect(client.rows.size).toBe(1)
  })
})

describe('PrismaOutboxStore — claim (multi-replica relay)', () => {
  it('two relays over the same database never dispatch an entry twice', async () => {
    const client = makeClient()
    const relays = [0, 1].map(
      () => new Outbox(prismaOutboxStore(client as unknown as PrismaEventsClient, { claim: true }).store),
    )
    for (let i = 0; i < 20; i++) await relays[0]!.enqueue('e', { i })

    const deliveries: number[] = []
    const dispatch = async (entry: OutboxEntry) => {
      deliveries.push((entry.payload as { i: number }).i)
      await new Promise((r) => setTimeout(r, 1))
    }
    const results = await Promise.all(relays.map((relay) => relay.flush(dispatch)))

    expect(results[0]!.published + results[1]!.published).toBe(20)
    expect(deliveries.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    const rows = [...client.rows.values()]
    expect(rows.every((r) => r.publishedAt !== null && r.lockedUntil === null && r.lockedBy === null)).toBe(true)
  })

  it('claim() is a conditional update: only rows unclaimed (or expired) are won', async () => {
    const client = makeClient()
    const store = new PrismaOutboxStore(client as unknown as PrismaEventsClient, { claim: true })
    await store.enqueue({ id: 'a', event: 'e', payload: 1, createdAt: 1 })
    await store.enqueue({ id: 'b', event: 'e', payload: 1, createdAt: 2 })

    expect(await store.claim!(['a'], { token: 't1', until: 100, now: 0 })).toEqual(['a'])
    expect(await store.claim!(['a', 'b'], { token: 't2', until: 100, now: 50 })).toEqual(['b'])
    // pending() hides actively claimed rows from other relays…
    expect((await store.pending(10, 5, { now: 50 })).map((e) => e.id)).toEqual([])
    // …until the lease expires.
    expect((await store.pending(10, 5, { now: 100 })).map((e) => e.id)).toEqual(['a', 'b'])
    expect(await store.claim!(['a'], { token: 't3', until: 200, now: 100 })).toEqual(['a'])
  })

  it('markFailed with retryAt keeps the row unclaimable until then (cross-replica backoff)', async () => {
    const client = makeClient()
    const store = new PrismaOutboxStore(client as unknown as PrismaEventsClient, { claim: true })
    await store.enqueue({ id: 'a', event: 'e', payload: 1, createdAt: 1 })
    await store.claim!(['a'], { token: 't', until: 1_000, now: 0 })
    await store.markFailed('a', 'down', { retryAt: 500 })
    expect(client.rows.get('a')).toMatchObject({ attempts: 1, lastError: 'down', lockedBy: null })
    expect((await store.pending(10, 5, { now: 499 })).length).toBe(0)
    expect((await store.pending(10, 5, { now: 500 })).length).toBe(1)
  })

  it('keeps the tenant-fairness filter working alongside the claim filter', async () => {
    const client = makeClient()
    const store = new PrismaOutboxStore(client as unknown as PrismaEventsClient, { claim: true })
    await store.enqueue({ id: 'a', event: 'e', payload: 1, tenantId: 'acme', createdAt: 1 })
    await store.enqueue({ id: 'g', event: 'e', payload: 1, createdAt: 2 })
    await store.enqueue({ id: 'b', event: 'e', payload: 1, tenantId: 'globex', createdAt: 3 })
    await store.claim!(['b'], { token: 't', until: 100, now: 0 })
    expect((await store.pending(10, 5, { excludeTenantIds: ['acme'], now: 10 })).map((e) => e.id)).toEqual(['g'])
    expect((await store.pending(10, 5, { excludeGlobal: true, now: 10 })).map((e) => e.id)).toEqual(['a'])
  })

  it('without { claim: true } the store has no claim() and never touches the lock columns', async () => {
    const client = makeClient()
    const writes: any[] = []
    const updateMany = client.outboxEntry.updateMany
    client.outboxEntry.updateMany = (a: any) => {
      writes.push(a.data)
      return updateMany(a)
    }
    const store = new PrismaOutboxStore(client as unknown as PrismaEventsClient)
    expect(store.claim).toBeUndefined()
    await store.enqueue({ id: 'a', event: 'e', payload: 1, createdAt: 1 })
    await store.markFailed('a', 'x')
    await store.markPublished('a', 5)
    expect(writes.every((d) => !('lockedUntil' in d) && !('lockedBy' in d))).toBe(true)
  })
})
