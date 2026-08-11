import { describe, expect, it } from 'vitest'
import {
  PrismaPaymentStore,
  PrismaRecurringStore,
  type PrismaPaymentsClient,
  prismaPaymentStores,
} from '../src/index.js'

interface PayRow {
  id: string
  status: string
  amount: bigint
  billableId: string | null
  reference: string | null
  raw: string | null
  createdAt: Date
  updatedAt: Date
}
interface RecRow {
  billableId: string
  plan: string
  amount: bigint
  interval: string
  status: string
  paidThrough: Date | null
  pendingPaymentId: string | null
  customer: string | null
  createdAt: Date
  updatedAt: Date
}

type PayInput = { id: string; status?: string; amount?: bigint; billableId?: string | null; reference?: string | null; raw?: string | null }
const payRow = (row: PayInput, ts: Date): PayRow => ({
  id: row.id,
  status: row.status ?? 'pending',
  amount: row.amount ?? 0n,
  billableId: row.billableId ?? null,
  reference: row.reference ?? null,
  raw: row.raw ?? null,
  createdAt: ts,
  updatedAt: ts,
})

// In-memory fake of the Prisma delegate surface for payments + recurring.
function makeClient() {
  const payments = new Map<string, PayRow>()
  const recurring = new Map<string, RecRow>()
  const now = () => new Date(1_700_000_000_000)
  const client = {
    payment: {
      async findUnique({ where }: { where: { id: string } }) {
        return payments.get(where.id) ?? null
      },
      async createMany({ data, skipDuplicates }: { data: PayInput[]; skipDuplicates?: boolean }) {
        let count = 0
        for (const row of data) {
          if (skipDuplicates && payments.has(row.id)) continue
          payments.set(row.id, payRow(row, now()))
          count++
        }
        return { count }
      },
      async upsert({ where, create, update }: { where: { id: string }; create: PayInput; update: Partial<PayRow> }) {
        const existing = payments.get(where.id)
        if (existing) {
          Object.assign(existing, update, { updatedAt: now() })
          return existing
        }
        const row = payRow({ ...create, id: where.id }, now())
        payments.set(where.id, row)
        return row
      },
      async update({ where, data }: { where: { id: string }; data: Partial<PayRow> }) {
        const existing = payments.get(where.id)!
        Object.assign(existing, data, { updatedAt: now() })
        return existing
      },
    },
    recurringSubscription: {
      async findUnique({ where }: { where: { billableId: string } }) {
        return recurring.get(where.billableId) ?? null
      },
      async findMany({ orderBy }: { orderBy?: { billableId?: 'asc' } }) {
        const rows = [...recurring.values()]
        if (orderBy?.billableId === 'asc') rows.sort((a, b) => a.billableId.localeCompare(b.billableId))
        return rows
      },
      async upsert({ where, create, update }: { where: { billableId: string }; create: RecRow; update: Partial<RecRow> }) {
        const existing = recurring.get(where.billableId)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create }
        recurring.set(where.billableId, row)
        return row
      },
      async update({ where, data }: { where: { billableId: string }; data: Partial<RecRow> }) {
        const existing = recurring.get(where.billableId)!
        Object.assign(existing, data)
        return existing
      },
    },
  }
  return client as unknown as PrismaPaymentsClient
}

describe('PrismaPaymentStore', () => {
  it('idempotent create, status flip, and bigint/raw mapping', async () => {
    const store = new PrismaPaymentStore(makeClient())
    await store.create({ id: 'p1', amount: 500000, billableId: 'acme', reference: 'o1', raw: { g: 1 } })
    await store.create({ id: 'p1', amount: 999 }) // skipDuplicates → no-op
    let rec = await store.get('p1')
    expect(rec).toMatchObject({ id: 'p1', status: 'pending', amount: 500000, billableId: 'acme', reference: 'o1', raw: { g: 1 } })

    await store.setStatus('p1', 'paid', { amount: 500000 })
    rec = await store.get('p1')
    expect(rec?.status).toBe('paid')
    expect(rec?.amount).toBe(500000)
  })

  it('setStatus upserts a never-recorded payment', async () => {
    const store = new PrismaPaymentStore(makeClient())
    await store.setStatus('ghost', 'paid', { amount: 42 })
    expect(await store.get('ghost')).toMatchObject({ id: 'ghost', status: 'paid', amount: 42 })
  })

  it('falls back to update on a P2002 unique-violation race', async () => {
    const client = makeClient()
    const realUpsert = client.payment.upsert.bind(client.payment)
    let firedOnce = false
    // Simulate a concurrent create winning: the first upsert throws P2002.
    client.payment.upsert = (async (a: unknown) => {
      if (!firedOnce) {
        firedOnce = true
        const e = new Error('duplicate') as Error & { code: string }
        e.code = 'P2002'
        throw e
      }
      return realUpsert(a as never)
    }) as typeof client.payment.upsert
    const store = new PrismaPaymentStore(client)
    await store.create({ id: 'p2', amount: 100 }) // row exists for the fallback update
    await store.setStatus('p2', 'paid', { amount: 100 })
    expect((await store.get('p2'))?.status).toBe('paid')
  })
})

describe('PrismaRecurringStore', () => {
  it('saves, gets, and lists', async () => {
    const store = new PrismaRecurringStore(makeClient())
    await store.save({
      billableId: 'acme',
      plan: 'pro',
      amount: 250000,
      interval: 'monthly',
      status: 'active',
      paidThrough: 111,
      pendingPaymentId: 'r1',
      customer: { phone: '+244900000000' },
      createdAt: 1,
      updatedAt: 2,
    })
    const s = await store.get('acme')
    expect(s).toMatchObject({
      billableId: 'acme',
      amount: 250000,
      status: 'active',
      paidThrough: 111,
      pendingPaymentId: 'r1',
      customer: { phone: '+244900000000' },
    })
    expect(await store.list()).toHaveLength(1)
  })
})

describe('prismaPaymentStores', () => {
  it('fails fast when a model is missing', () => {
    expect(() => prismaPaymentStores({} as unknown as PrismaPaymentsClient)).toThrow(/payment/)
  })
})
