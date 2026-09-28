import { describe, expect, it } from 'vitest'
import {
  ColumnLengthError,
  type PrismaPaymentsClient,
  type PrismaSubscriptionsClient,
  prismaPaymentStores,
  prismaSubscriptionsStores,
} from '../src/index.js'

/** Records every write; the guard must stop a refused write before it gets here. */
function recording(): { client: PrismaSubscriptionsClient & PrismaPaymentsClient; writes: string[] } {
  const writes: string[] = []
  const w =
    (op: string, result: unknown = {}) =>
    async () => {
      writes.push(op)
      return result as never
    }
  const read = async () => null
  return {
    writes,
    client: {
      subscription: { findUnique: read, findMany: async () => [], upsert: w('subscription.upsert') },
      usageCounter: {
        findUnique: read,
        createMany: w('usage.createMany', { count: 1 }),
        updateMany: w('usage.updateMany', { count: 1 }),
      },
      webhookEvent: { createMany: w('webhook.createMany', { count: 1 }), deleteMany: w('webhook.deleteMany', { count: 0 }) },
      payment: { findUnique: read, createMany: w('payment.createMany', { count: 1 }), upsert: w('payment.upsert'), update: w('payment.update') },
      recurringSubscription: { findUnique: read, findMany: async () => [], upsert: w('recurring.upsert'), update: w('recurring.update') },
    },
  }
}

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it('a >191 webhook event id is refused — cut, it would collide with another id and drop that event', async () => {
    const { client, writes } = recording()
    const { webhooks } = prismaSubscriptionsStores(client, { columnLimits: 'mysql' })
    await expect(webhooks.markProcessed(`evt_${'x'.repeat(200)}`)).rejects.toMatchObject({ column: 'WebhookEvent.id' })
    expect(await webhooks.markProcessed('evt_1')).toBe(true)
    expect(writes).toEqual(['webhook.createMany'])
  })

  it('usage counters and subscriptions refuse over-long keys before writing', async () => {
    const { client, writes } = recording()
    const { usage, store } = prismaSubscriptionsStores(client, { columnLimits: 'mysql' })
    await expect(usage.increment('b1', 'f'.repeat(192), '2026-09', 1)).rejects.toBeInstanceOf(ColumnLengthError)
    await expect(usage.consume('b1', 'f'.repeat(192), '2026-09', 1, 10)).rejects.toBeInstanceOf(ColumnLengthError)
    await expect(
      store.save({ billableId: 'b1', plan: 'p'.repeat(192), period: 'monthly', status: 'active' }),
    ).rejects.toMatchObject({ column: 'Subscription.plan' })
    expect(writes).toEqual([])
  })

  it("'mysql' stores a large gateway payload (MEDIUMTEXT) and refuses a >191 reference", async () => {
    const { client, writes } = recording()
    const { payments, recurring } = prismaPaymentStores(client, { columnLimits: 'mysql' })
    await payments.create({ id: 'p1', amount: 100, raw: { body: 'x'.repeat(50_000) } })
    await payments.setStatus('p1', 'paid', { raw: { body: 'y'.repeat(50_000) } })
    await expect(payments.create({ id: 'p2', amount: 1, reference: 'r'.repeat(192) })).rejects.toMatchObject({
      column: 'Payment.reference',
    })
    await expect(
      recurring.save({
        billableId: 'b'.repeat(192),
        plan: 'pro',
        amount: 1,
        interval: 'month',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      } as never),
    ).rejects.toMatchObject({ column: 'RecurringSubscription.billableId' })
    expect(writes).toEqual(['payment.createMany', 'payment.upsert'])
  })

  it('unset: no check (PostgreSQL / SQLite)', async () => {
    const { client, writes } = recording()
    await prismaSubscriptionsStores(client).webhooks.markProcessed('x'.repeat(500))
    expect(writes).toEqual(['webhook.createMany'])
  })
})
