import { assertMinorUnits } from './money.js'
import type { NewLineItem } from './invoice.js'

/**
 * Metered-billing depth — tiered pricing on top of the flat `overageLine`.
 * A `TieredPrice` prices consumed units through brackets, either **graduated**
 * (each unit priced by the bracket it falls into, like tax brackets) or
 * **volume** (all units priced at the single bracket the total lands in).
 * `meteredLine()` turns recorded usage into an invoice line. Pure domain.
 */

export interface PricingTier {
  /** Inclusive upper bound of this tier's units; `null` = unbounded (last tier). */
  upTo: number | null
  /** Price per unit within this tier, in minor units. */
  unitAmount: number
  /** Optional flat fee charged once when this tier has any usage. */
  flatAmount?: number
}

export interface TieredPrice {
  mode: 'graduated' | 'volume'
  /** Ordered ascending by `upTo`; the last tier should be `upTo: null`. */
  tiers: PricingTier[]
}

function assertTiers(price: TieredPrice): void {
  if (!price.tiers.length) throw new Error('TieredPrice needs at least one tier')
  price.tiers.forEach((t, i) => {
    assertMinorUnits(t.unitAmount, `tiers[${i}].unitAmount`)
    if (t.flatAmount !== undefined) assertMinorUnits(t.flatAmount, `tiers[${i}].flatAmount`)
  })
}

/** Total cost (minor units) for `units` under a tiered price. */
export function tieredCost(price: TieredPrice, units: number): number {
  const n = Math.max(0, Math.floor(units))
  if (n <= 0) return 0
  assertTiers(price)
  const tiers = price.tiers

  if (price.mode === 'volume') {
    const tier = tiers.find((t) => t.upTo === null || n <= t.upTo) ?? tiers[tiers.length - 1]!
    return (tier.flatAmount ?? 0) + Math.round(n * tier.unitAmount)
  }

  // graduated: fill each bracket in turn
  let cost = 0
  let lower = 0
  let remaining = n
  for (const tier of tiers) {
    if (remaining <= 0) break
    const upper = tier.upTo ?? Infinity
    const capacity = upper - lower
    const inTier = Math.min(remaining, capacity)
    if (inTier > 0) {
      cost += (tier.flatAmount ?? 0) + Math.round(inTier * tier.unitAmount)
      remaining -= inTier
    }
    lower = upper
  }
  return cost
}

/**
 * An invoice line for metered usage under a tiered price. `includedUnits` (the
 * plan's free allowance) is subtracted first; returns `null` when nothing is
 * billable. The tiered total is a single line (quantity 1) — tiered pricing has
 * no single per-unit rate — with the breakdown in `metadata`.
 */
export function meteredLine(
  feature: string,
  opts: { units: number; price: TieredPrice; includedUnits?: number },
): NewLineItem | null {
  const billable = Math.max(0, Math.floor(opts.units) - Math.floor(opts.includedUnits ?? 0))
  if (billable <= 0) return null
  const amount = tieredCost(opts.price, billable)
  if (amount <= 0) return null
  return {
    description: `${feature} usage (${billable} units, ${opts.price.mode})`,
    quantity: 1,
    unitAmount: amount,
    metadata: {
      feature,
      units: opts.units,
      billableUnits: billable,
      includedUnits: opts.includedUnits ?? 0,
      mode: opts.price.mode,
    },
  }
}
