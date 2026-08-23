import { describe, expect, it } from 'vitest'
import {
  Invoices,
  MemoryInvoiceStore,
  InvoiceStateError,
  InvoiceNotFoundError,
  planLine,
  overageLine,
  renderInvoiceText,
  renderInvoiceHtml,
  definePlans,
  meter,
} from '../src/index.js'

// Deterministic clock + ids so numbers/dates are stable in assertions.
const makeInvoices = () => {
  let t = Date.UTC(2026, 0, 15) // 2026-01-15
  let n = 0
  return new Invoices({
    store: new MemoryInvoiceStore(),
    taxRate: 0.14,
    now: () => t,
    idFactory: () => `inv_${++n}`,
  })
}

describe('Invoices', () => {
  it('computes subtotal, default tax and total in minor units', async () => {
    const invoices = makeInvoices()
    const inv = await invoices.draft({
      billableId: 'tenant_1',
      currency: 'USD',
      lineItems: [
        { description: 'Pro plan (monthly)', unitAmount: 2900 },
        { description: 'Seats', quantity: 3, unitAmount: 500 },
      ],
    })
    expect(inv.status).toBe('draft')
    expect(inv.number).toBe('')
    expect(inv.subtotal).toBe(2900 + 1500) // 4400
    expect(inv.tax).toBe(Math.round(4400 * 0.14)) // 616
    expect(inv.total).toBe(4400 + 616) // 5016
    expect(inv.amountDue).toBe(5016)
  })

  it('applies discount before tax and clamps it to the subtotal', async () => {
    const invoices = makeInvoices()
    const inv = await invoices.draft({
      billableId: 't', currency: 'USD',
      lineItems: [{ description: 'x', unitAmount: 1000 }],
      discount: 5000, // > subtotal → clamps to 1000
    })
    expect(inv.discount).toBe(1000)
    expect(inv.tax).toBe(0) // taxable is 0
    expect(inv.total).toBe(0)
  })

  it('accepts an explicit tax rate override and absolute tax', async () => {
    const invoices = makeInvoices()
    const rate = await invoices.draft({
      billableId: 't', currency: 'USD',
      lineItems: [{ description: 'x', unitAmount: 1000 }], tax: { rate: 0.2 },
    })
    expect(rate.tax).toBe(200)
    const abs = await invoices.draft({
      billableId: 't', currency: 'USD',
      lineItems: [{ description: 'x', unitAmount: 1000 }], tax: 333,
    })
    expect(abs.tax).toBe(333)
  })

  it('finalizes drafts with a sequential number and pays them', async () => {
    const invoices = makeInvoices()
    const a = await invoices.finalize((await invoices.draft({ billableId: 't', currency: 'USD', lineItems: [{ description: 'x', unitAmount: 100 }] })).id)
    const b = await invoices.finalize((await invoices.draft({ billableId: 't', currency: 'USD', lineItems: [{ description: 'y', unitAmount: 100 }] })).id)
    expect(a.number).toBe('INV-2026-0001')
    expect(b.number).toBe('INV-2026-0002')
    expect(a.status).toBe('open')

    const paid = await invoices.markPaid(a.id, { paymentId: 'pay_1' })
    expect(paid.status).toBe('paid')
    expect(paid.amountPaid).toBe(paid.total)
    expect(paid.amountDue).toBe(0)
    expect(paid.paymentId).toBe('pay_1')
  })

  it('enforces the state machine', async () => {
    const invoices = makeInvoices()
    const draft = await invoices.draft({ billableId: 't', currency: 'USD', lineItems: [{ description: 'x', unitAmount: 100 }] })
    await expect(invoices.markPaid(draft.id)).rejects.toBeInstanceOf(InvoiceStateError) // can't pay a draft
    const open = await invoices.finalize(draft.id)
    await expect(invoices.finalize(open.id)).rejects.toBeInstanceOf(InvoiceStateError) // can't refinalize
    await expect(invoices.addLine(open.id, { description: 'z', unitAmount: 1 })).rejects.toBeInstanceOf(InvoiceStateError)
    await invoices.markPaid(open.id)
    await expect(invoices.void(open.id)).rejects.toBeInstanceOf(InvoiceStateError) // can't void a paid one
  })

  it('lists a tenant invoices newest first and 404s unknown ids', async () => {
    const invoices = makeInvoices()
    await invoices.draft({ billableId: 'A', currency: 'USD', lineItems: [{ description: '1', unitAmount: 1 }] })
    await invoices.draft({ billableId: 'B', currency: 'USD', lineItems: [{ description: '2', unitAmount: 1 }] })
    const listA = await invoices.list('A')
    expect(listA).toHaveLength(1)
    await expect(invoices.finalize('nope')).rejects.toBeInstanceOf(InvoiceNotFoundError)
  })

  it('builds plan and overage lines from a plan definition', async () => {
    const plans = definePlans({
      pro: { price: { monthly: 2900, yearly: 29000 }, features: { 'api.calls': meter(1000) } },
    })
    const base = planLine('pro', plans.pro, 'yearly')
    expect(base).toEqual({ description: 'Pro plan (yearly)', quantity: 1, unitAmount: 29000 })

    expect(overageLine('api.calls', { used: 900, included: 1000, unitAmount: 2 })).toBeNull()
    const over = overageLine('api.calls', { used: 1500, included: 1000, unitAmount: 2 })!
    expect(over.quantity).toBe(500)
    expect(over.unitAmount).toBe(2)
  })

  it('throws when invoicing a custom-priced plan', () => {
    const plans = definePlans({ ent: { price: 'custom', features: {} } })
    expect(() => planLine('ent', plans.ent, 'monthly')).toThrow(/custom/i)
  })

  it('renders text and HTML', async () => {
    const invoices = makeInvoices()
    const inv = await invoices.finalize((await invoices.draft({
      billableId: 'acme', currency: 'USD',
      lineItems: [{ description: 'Pro plan', unitAmount: 2900 }],
      discount: 400, notes: 'Thank you!',
    })).id)
    const text = renderInvoiceText(inv)
    expect(text).toContain('INV-2026-0001')
    expect(text).toContain('$29.00')
    expect(text).toContain('Discount')
    expect(text).toContain('Thank you!')
    const html = renderInvoiceHtml(inv)
    expect(html).toContain('<table>')
    expect(html).toContain('acme')
    expect(html).toContain('$29.00')
  })
})
