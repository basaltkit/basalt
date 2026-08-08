import { beforeEach, describe, expect, it } from 'vitest'
import {
  PrismaSubscriptionStore,
  type PrismaSubscriptionsClient,
  PrismaUsageStore,
  PrismaWebhookStore,
  prismaSubscriptionsStores,
} from '../src/index.js'

interface SubRow {
  billableId: string; plan: string; period: string; status: string
  trialEndsAt: Date | null; cancelAtPeriodEnd: boolean | null; canceledAt: Date | null; gatewayRef: string | null
}
interface UsageRow { billableId: string; feature: string; periodKey: string; value: number }

// In-memory fake of the Prisma delegate surface — the injectable-client pattern.
function makeFakeClient(): PrismaSubscriptionsClient {
  const subs = new Map<string, SubRow>()
  const usage = new Map<string, UsageRow>()
  const webhooks = new Set<string>()
  const ukey = (b: string, f: string, p: string): string => `${b}::${f}::${p}`

  return {
    subscription: {
      async findUnique({ where }) {
        return subs.get(where.billableId) ?? null
      },
      async findMany({ orderBy }) {
        const rows = [...subs.values()]
        if (orderBy?.billableId === 'asc') rows.sort((a, b) => a.billableId.localeCompare(b.billableId))
        return rows
      },
      async upsert({ where, create, update }) {
        const existing = subs.get(where.billableId)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create } as SubRow
        subs.set(row.billableId, row)
        return row
      },
    },
    usageCounter: {
      async findUnique({ where }) {
        const { billableId, feature, periodKey } = where.billableId_feature_periodKey
        return usage.get(ukey(billableId, feature, periodKey)) ?? null
      },
      async upsert({ where, create, update }) {
        const { billableId, feature, periodKey } = where.billableId_feature_periodKey
        const k = ukey(billableId, feature, periodKey)
        const existing = usage.get(k)
        if (existing) {
          if (update.value?.increment !== undefined) existing.value += update.value.increment
          return existing
        }
        const row = { ...create } as UsageRow
        usage.set(k, row)
        return row
      },
      async updateMany({ where, data }) {
        const row = usage.get(ukey(where.billableId, where.feature, where.periodKey))
        if (!row) return { count: 0 }
        if (where.value?.lte !== undefined && row.value > where.value.lte) return { count: 0 }
        if (data.value?.increment !== undefined) row.value += data.value.increment
        return { count: 1 }
      },
    },
    webhookEvent: {
      async createMany({ data }) {
        let count = 0
        for (const { id } of data) {
          if (!webhooks.has(id)) { webhooks.add(id); count++ }
        }
        return { count }
      },
      async deleteMany({ where }) {
        return { count: webhooks.delete(where.id) ? 1 : 0 }
      },
    },
  }
}

let client: PrismaSubscriptionsClient
beforeEach(() => {
  client = makeFakeClient()
})

describe('PrismaSubscriptionStore', () => {
  it('saves, upserts, gets and lists', async () => {
    const store = new PrismaSubscriptionStore(client)
    await store.save({ billableId: 'acme', plan: 'pro', period: 'monthly', status: 'active' })
    await store.save({
      billableId: 'globex', plan: 'team', period: 'yearly', status: 'trialing',
      trialEndsAt: 999, cancelAtPeriodEnd: true, canceledAt: 1000, gatewayRef: 'sub_x',
    })

    const acme = await store.get('acme')
    expect(acme?.plan).toBe('pro')
    expect(acme?.trialEndsAt).toBeUndefined()
    expect(acme?.cancelAtPeriodEnd).toBeUndefined()

    expect(await store.get('globex')).toEqual({
      billableId: 'globex', plan: 'team', period: 'yearly', status: 'trialing',
      trialEndsAt: 999, cancelAtPeriodEnd: true, canceledAt: 1000, gatewayRef: 'sub_x',
    })

    expect(await store.get('missing')).toBeNull()

    await store.save({ billableId: 'acme', plan: 'enterprise', period: 'monthly', status: 'active' })
    expect((await store.get('acme'))?.plan).toBe('enterprise')

    expect((await store.all()).map((s) => s.billableId)).toEqual(['acme', 'globex'])

    await store.save({ billableId: 'z', plan: 'pro', period: 'monthly', status: 'active', cancelAtPeriodEnd: false })
    expect((await store.get('z'))?.cancelAtPeriodEnd).toBe(false)
  })
})

describe('PrismaWebhookStore', () => {
  it('claims an id once and can release it', async () => {
    const store = new PrismaWebhookStore(client)
    expect(await store.markProcessed('evt_1')).toBe(true)
    expect(await store.markProcessed('evt_1')).toBe(false)
    await store.release('evt_1')
    expect(await store.markProcessed('evt_1')).toBe(true)
  })
})

describe('PrismaUsageStore', () => {
  it('gets, increments and reports totals', async () => {
    const store = new PrismaUsageStore(client)
    expect(await store.get('acme', 'api', 'lifetime')).toBe(0)
    expect(await store.increment('acme', 'api', 'lifetime', 3)).toBe(3)
    expect(await store.increment('acme', 'api', 'lifetime', 2)).toBe(5)
    expect(await store.get('acme', 'api', 'lifetime')).toBe(5)
    expect(await store.get('acme', 'api', '2026-08')).toBe(0)
  })

  it('consume applies only within the limit', async () => {
    const store = new PrismaUsageStore(client)
    expect(await store.consume('acme', 'seats', 'lifetime', 3, 5)).toEqual({ applied: true, used: 3 })
    expect(await store.consume('acme', 'seats', 'lifetime', 2, 5)).toEqual({ applied: true, used: 5 })
    expect(await store.consume('acme', 'seats', 'lifetime', 1, 5)).toEqual({ applied: false, used: 5 })
    expect(await store.get('acme', 'seats', 'lifetime')).toBe(5)
  })

  it('never overshoots the limit under concurrent consume', async () => {
    const store = new PrismaUsageStore(client)
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.consume('acme', 'seats', 'm', 1, 5)),
    )
    expect(results.filter((r) => r.applied).length).toBe(5)
    expect(await store.get('acme', 'seats', 'm')).toBe(5)
  })

  it('reports used=0 if the counter row is absent on read-back (defensive)', async () => {
    // a race could drop the row between updateMany and read-back
    const raced: PrismaSubscriptionsClient = {
      ...client,
      usageCounter: {
        upsert: async () => ({ billableId: 'a', feature: 'f', periodKey: 'p', value: 0 }),
        updateMany: async () => ({ count: 0 }),
        findUnique: async () => null,
      },
    }
    const store = new PrismaUsageStore(raced)
    expect(await store.consume('a', 'f', 'p', 1, 5)).toEqual({ applied: false, used: 0 })
  })
})

describe('prismaSubscriptionsStores', () => {
  it('bundles all three stores named for subscriptionsPlugin', () => {
    const s = prismaSubscriptionsStores(client)
    expect(s.store).toBeInstanceOf(PrismaSubscriptionStore)
    expect(s.usage).toBeInstanceOf(PrismaUsageStore)
    expect(s.webhooks).toBeInstanceOf(PrismaWebhookStore)
  })
})
