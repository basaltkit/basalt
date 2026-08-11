import { BasaltError, type DurationInput } from '@basaltkit/core'

export class UnknownPlanError extends BasaltError {
  constructor(plan: string) {
    super('BILLING_UNKNOWN_PLAN', `Plan "${plan}" is not defined in definePlans().`)
  }
}

/** Metered feature: the limit resets every billing month. */
export interface Meter {
  readonly meter: true
  readonly limit: number
}

/** `'api.requests': meter(100_000)` — consumed monthly. */
export function meter(limit: number): Meter {
  return { meter: true, limit }
}

/**
 * boolean → on/off flag · number → consumable balance (lifetime)
 * meter(n) → monthly-reset quota · Infinity → unlimited
 */
export type FeatureValue = boolean | number | Meter

export type BillingPeriod = 'monthly' | 'yearly'

export interface PlanDefinition {
  /**
   * Price in the currency's minor unit (integer; cents — `2900` = $29.00).
   * 0 = free · number = same price both periods · object = per period ·
   * 'custom' = sales-led. Only gated (`> 0`) and displayed here; the actual
   * Stripe charge uses a pre-created price id on the gateway.
   */
  price: number | { monthly: number; yearly: number } | 'custom'
  trial?: DurationInput
  features: Record<string, FeatureValue>
}

export type Plans = Record<string, PlanDefinition>

export function definePlans<T extends Plans>(plans: T): T {
  return plans
}

export function planPrice(plan: PlanDefinition, period: BillingPeriod): number | 'custom' {
  if (plan.price === 'custom') return 'custom'
  return typeof plan.price === 'number' ? plan.price : plan.price[period]
}

/** Normalized limit of a feature: false→0, true→Infinity. */
export function featureLimit(value: FeatureValue | undefined): number {
  if (value === undefined || value === false) return 0
  if (value === true) return Number.POSITIVE_INFINITY
  return typeof value === 'number' ? value : value.limit
}

export function isMeter(value: FeatureValue | undefined): value is Meter {
  return typeof value === 'object' && value !== null && value.meter === true
}
