import { describe, expect, it } from 'vitest'
import { Invoices, MemoryInvoiceStore } from '@basaltkit/subscriptions'
import { renderInvoicePdf } from '../src/index.js'

describe('renderInvoicePdf', () => {
  it('produces a valid PDF buffer from an invoice', async () => {
    const invoices = new Invoices({ store: new MemoryInvoiceStore(), now: () => 0 })
    const draft = await invoices.draft({
      billableId: 'acme',
      currency: 'USD',
      lineItems: [
        { description: 'Pro plan (monthly)', unitAmount: 2900 },
        { description: 'Extra seats', quantity: 3, unitAmount: 500 },
      ],
      discount: 400,
      tax: { rate: 0.14 },
      notes: 'Thank you for your business!',
    })
    const inv = await invoices.finalize(draft.id)

    const pdf = await renderInvoicePdf(inv, { businessName: 'Acme Inc' })
    expect(Buffer.isBuffer(pdf)).toBe(true)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-') // PDF magic bytes
    expect(pdf.length).toBeGreaterThan(800)
  })

  it('renders a draft invoice too', async () => {
    const invoices = new Invoices({ store: new MemoryInvoiceStore(), now: () => 0 })
    const draft = await invoices.draft({
      billableId: 't', currency: 'EUR', lineItems: [{ description: 'x', unitAmount: 1000 }],
    })
    const pdf = await renderInvoicePdf(draft)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
