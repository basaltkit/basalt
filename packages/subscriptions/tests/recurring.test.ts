import { describe, expect, it } from 'vitest'
import {
  FakePaymentGateway,
  RecurringReferenceBilling,
  addInterval,
  type PaymentEvent,
} from '../src/index.js'

const paidEvent = (paymentId: string, over: Partial<PaymentEvent> = {}): PaymentEvent => ({
  id: `evt-${paymentId}`,
  type: 'payment.succeeded',
  paymentId,
  amount: 5000,
  billableId: 'acme',
  ...over,
})

describe('addInterval', () => {
  it('adds a calendar month and year', () => {
    const jan = Date.parse('2026-01-15T00:00:00Z')
    expect(new Date(addInterval(jan, 'monthly')).toISOString().slice(0, 10)).toBe('2026-02-15')
    expect(new Date(addInterval(jan, 'yearly')).toISOString().slice(0, 10)).toBe('2027-01-15')
  })
})

describe('RecurringReferenceBilling', () => {
  const setup = () => {
    const gateway = new FakePaymentGateway()
    const billing = new RecurringReferenceBilling({ gateway, leadDays: 5 })
    return { gateway, billing }
  }

  it('subscribes, issues the first reference, and stays pending until paid', async () => {
    const { billing } = setup()
    const { instruction } = await billing.subscribe({ billableId: 'acme', plan: 'pro', amount: 5000, interval: 'monthly' })

    const sub = await billing.get('acme')
    expect(sub?.status).toBe('pending')
    expect(sub?.pendingPaymentId).toBe(instruction.id)
    expect(sub?.paidThrough).toBeUndefined()
    // not "due" — we already issued the outstanding reference
    expect(await billing.due()).toHaveLength(0)
  })

  it('activates and sets paidThrough one interval out when the reference is paid', async () => {
    const { billing } = setup()
    const { instruction } = await billing.subscribe({ billableId: 'acme', plan: 'pro', amount: 5000, interval: 'monthly' })

    const before = Date.now()
    const res = await billing.handleEvent(paidEvent(instruction.id))
    const after = Date.now()
    expect(res.applied).toBe(true)
    expect(res.subscription?.status).toBe('active')
    expect(res.subscription?.pendingPaymentId).toBeUndefined()
    // paidThrough is one month out from "now" (base is between before and after)
    const pt = res.subscription!.paidThrough!
    expect(pt).toBeGreaterThanOrEqual(addInterval(before, 'monthly'))
    expect(pt).toBeLessThanOrEqual(addInterval(after, 'monthly'))
  })

  it('is idempotent: a retried webhook does not double-extend', async () => {
    const { billing } = setup()
    const { instruction } = await billing.subscribe({ billableId: 'acme', plan: 'pro', amount: 5000, interval: 'monthly' })
    const first = await billing.handleEvent(paidEvent(instruction.id))
    const paidThrough = first.subscription!.paidThrough
    const second = await billing.handleEvent(paidEvent(instruction.id)) // same event id
    expect(second.applied).toBe(false)
    expect((await billing.get('acme'))!.paidThrough).toBe(paidThrough)
  })

  it('becomes due within leadDays of paidThrough, then re-issues', async () => {
    const { billing } = setup()
    const { instruction } = await billing.subscribe({ billableId: 'acme', plan: 'pro', amount: 5000, interval: 'monthly' })
    await billing.handleEvent(paidEvent(instruction.id))

    const sub = await billing.get('acme')
    const nearEnd = sub!.paidThrough! - 2 * 86_400_000 // 2 days before end
    expect((await billing.due(nearEnd)).map((s) => s.billableId)).toEqual(['acme'])
    const wellBefore = sub!.paidThrough! - 20 * 86_400_000
    expect(await billing.due(wellBefore)).toHaveLength(0)

    const next = await billing.issueNext('acme')
    expect((await billing.get('acme'))!.pendingPaymentId).toBe(next.id)
  })

  it('stacks a second paid period onto the end of the first', async () => {
    const { billing } = setup()
    const { instruction } = await billing.subscribe({ billableId: 'acme', plan: 'pro', amount: 5000, interval: 'monthly' })
    const first = await billing.handleEvent(paidEvent(instruction.id))
    const firstEnd = first.subscription!.paidThrough!

    const next = await billing.issueNext('acme')
    const second = await billing.handleEvent(paidEvent(next.id, { id: 'evt-2' }))
    expect(second.subscription!.paidThrough).toBe(addInterval(firstEnd, 'monthly'))
  })

  it('marks past_due on a failed payment', async () => {
    const { billing } = setup()
    const { instruction } = await billing.subscribe({ billableId: 'acme', plan: 'pro', amount: 5000, interval: 'monthly' })
    const res = await billing.handleEvent(paidEvent(instruction.id, { id: 'evt-f', type: 'payment.failed' }))
    expect(res.subscription?.status).toBe('past_due')
  })

  it('cancel stops it being due', async () => {
    const { billing } = setup()
    const { instruction } = await billing.subscribe({ billableId: 'acme', plan: 'pro', amount: 5000, interval: 'monthly' })
    await billing.handleEvent(paidEvent(instruction.id))
    await billing.cancel('acme')
    expect((await billing.get('acme'))?.status).toBe('canceled')
    expect(await billing.due(Date.now() + 400 * 86_400_000)).toHaveLength(0)
  })
})
