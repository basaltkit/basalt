import { describe, expect, it } from 'vitest'
import { sqlitePaymentStores } from '../src/index.js'

describe('SqlitePaymentStore', () => {
  it('idempotent create, status flip, and int/raw mapping', async () => {
    const { payments } = sqlitePaymentStores(':memory:')
    await payments.create({ id: 'p1', amount: 500000, billableId: 'acme', reference: 'o1', raw: { g: 1 } })
    await payments.create({ id: 'p1', amount: 999 }) // INSERT OR IGNORE → no-op
    let rec = await payments.get('p1')
    expect(rec).toMatchObject({ id: 'p1', status: 'pending', amount: 500000, billableId: 'acme', reference: 'o1', raw: { g: 1 } })

    await payments.setStatus('p1', 'paid', { amount: 500000 })
    rec = await payments.get('p1')
    expect(rec?.status).toBe('paid')
    expect(rec?.amount).toBe(500000)
    expect(rec!.updatedAt).toBeGreaterThanOrEqual(rec!.createdAt)
  })

  it('setStatus inserts a never-recorded payment', async () => {
    const { payments } = sqlitePaymentStores(':memory:')
    await payments.setStatus('ghost', 'paid', { amount: 42 })
    expect(await payments.get('ghost')).toMatchObject({ id: 'ghost', status: 'paid', amount: 42 })
  })

  it('get returns undefined for an unknown id', async () => {
    const { payments } = sqlitePaymentStores(':memory:')
    expect(await payments.get('nope')).toBeUndefined()
  })
})

describe('SqliteRecurringStore', () => {
  it('saves, updates, gets, and lists', async () => {
    const { recurring } = sqlitePaymentStores(':memory:')
    await recurring.save({
      billableId: 'acme',
      plan: 'pro',
      amount: 250000,
      interval: 'monthly',
      status: 'pending',
      pendingPaymentId: 'r1',
      customer: { phone: '+244900000000' },
      createdAt: 1,
      updatedAt: 2,
    })
    // upsert path
    await recurring.save({
      billableId: 'acme',
      plan: 'pro',
      amount: 250000,
      interval: 'monthly',
      status: 'active',
      paidThrough: 111,
      createdAt: 1,
      updatedAt: 3,
    })
    const s = await recurring.get('acme')
    expect(s).toMatchObject({
      billableId: 'acme',
      amount: 250000,
      interval: 'monthly',
      status: 'active',
      paidThrough: 111,
    })
    expect(s?.pendingPaymentId).toBeUndefined() // cleared on the second save
    expect(await recurring.list()).toHaveLength(1)
  })
})
