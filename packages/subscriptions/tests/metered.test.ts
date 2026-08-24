import { describe, expect, it } from 'vitest'
import { tieredCost, meteredLine, Invoices, MemoryInvoiceStore, type TieredPrice } from '../src/index.js'

const graduated: TieredPrice = {
  mode: 'graduated',
  tiers: [
    { upTo: 1000, unitAmount: 2 }, // first 1000 units @ $0.02
    { upTo: null, unitAmount: 1 }, // everything above @ $0.01
  ],
}
const volume: TieredPrice = {
  mode: 'volume',
  tiers: [
    { upTo: 1000, unitAmount: 2 },
    { upTo: null, unitAmount: 1 },
  ],
}

describe('tieredCost', () => {
  it('graduated: each bracket priced in turn', () => {
    expect(tieredCost(graduated, 500)).toBe(1000) // 500 × 2
    expect(tieredCost(graduated, 1000)).toBe(2000) // 1000 × 2
    expect(tieredCost(graduated, 1500)).toBe(2500) // 1000×2 + 500×1
  })
  it('volume: all units at the bracket the total lands in', () => {
    expect(tieredCost(volume, 500)).toBe(1000) // 500 × 2 (first bracket)
    expect(tieredCost(volume, 1500)).toBe(1500) // 1500 × 1 (unbounded bracket)
  })
  it('handles flat fees per entered bracket (graduated)', () => {
    const p: TieredPrice = {
      mode: 'graduated',
      tiers: [
        { upTo: 1000, unitAmount: 2, flatAmount: 100 },
        { upTo: null, unitAmount: 1 },
      ],
    }
    expect(tieredCost(p, 1500)).toBe(100 + 2000 + 500) // 2600
  })
  it('is zero for non-positive usage', () => {
    expect(tieredCost(graduated, 0)).toBe(0)
    expect(tieredCost(graduated, -5)).toBe(0)
  })
})

describe('meteredLine', () => {
  it('bills only usage above the included allowance', () => {
    const line = meteredLine('api.calls', { units: 1500, includedUnits: 1000, price: graduated })!
    expect(line.quantity).toBe(1)
    expect(line.unitAmount).toBe(1000) // 500 billable @ $0.01 (graduated: falls in 2nd bracket after 1000)
    expect(line.metadata).toMatchObject({ feature: 'api.calls', billableUnits: 500 })
  })
  it('returns null when nothing is billable', () => {
    expect(meteredLine('api.calls', { units: 800, includedUnits: 1000, price: graduated })).toBeNull()
  })
})

describe('metered line on an invoice', () => {
  it('drafts an invoice from a metered line', async () => {
    const invoices = new Invoices({ store: new MemoryInvoiceStore(), now: () => 0 })
    const line = meteredLine('api.calls', { units: 2500, includedUnits: 0, price: graduated })!
    const inv = await invoices.draft({ billableId: 't', currency: 'USD', lineItems: [line] })
    // 1000×2 + 1500×1 = 3500
    expect(inv.subtotal).toBe(3500)
    expect(inv.lineItems[0]!.amount).toBe(3500)
  })
})
