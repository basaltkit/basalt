// Types only — erased at build time, keeping @basaltkit/dashboard free of a
// runtime dependency on @basaltkit/subscriptions (browser-safe), exactly like
// metrics.ts. planPrice normalization is inlined here for the same reason.
import type { PlanDefinition, SubscriptionRecord } from '@basaltkit/subscriptions'
import type { BillingMetrics } from './metrics.js'

const round2 = (value: number): number => Math.round(value * 100) / 100

/** Monthly recurring revenue a single subscription contributes (0 unless active + numeric). */
function subscriptionMrr(
  sub: SubscriptionRecord,
  plans: Record<string, PlanDefinition>,
): number {
  if (sub.status !== 'active') return 0
  const plan = plans[sub.plan]
  if (!plan || plan.price === 'custom') return 0
  const price = typeof plan.price === 'number' ? plan.price : plan.price[sub.period]
  if (!Number.isFinite(price)) return 0 // rejects NaN/Infinity, which `typeof === 'number'` would let through
  return sub.period === 'yearly' ? price / 12 : price
}

/**
 * The MRR bridge: decompose the change in MRR between two subscription
 * snapshots (keyed by `billableId`) into the standard SaaS movement buckets.
 * `new + reactivation + expansion − contraction − churned === net`.
 */
export interface MrrMovement {
  previousMrr: number
  currentMrr: number
  /** MRR from billables that are paying now and never appeared before. */
  new: number
  /** MRR from billables that existed but weren't paying (trial/canceled) and now are. */
  reactivation: number
  /** Added MRR from billables that were already paying and pay more now. */
  expansion: number
  /** Lost MRR (positive magnitude) from downgrades that still pay something. */
  contraction: number
  /** Lost MRR (positive magnitude) from billables that stopped paying entirely. */
  churned: number
  /** Signed net change = currentMrr − previousMrr. */
  net: number
}

export function mrrMovement(
  previous: SubscriptionRecord[],
  current: SubscriptionRecord[],
  plans: Record<string, PlanDefinition>,
): MrrMovement {
  const prev = new Map(previous.map((s) => [s.billableId, s]))
  const curr = new Map(current.map((s) => [s.billableId, s]))
  const ids = new Set([...prev.keys(), ...curr.keys()])

  const bucket = { new: 0, reactivation: 0, expansion: 0, contraction: 0, churned: 0 }
  let previousMrr = 0
  let currentMrr = 0

  for (const id of ids) {
    const prevSub = prev.get(id)
    const currSub = curr.get(id)
    const before = prevSub ? subscriptionMrr(prevSub, plans) : 0
    const after = currSub ? subscriptionMrr(currSub, plans) : 0
    previousMrr += before
    currentMrr += after

    if (before === 0 && after > 0) {
      // Paying now, wasn't before: a returning billable is reactivation, a
      // never-seen one is new business.
      if (prevSub) bucket.reactivation += after
      else bucket.new += after
    } else if (before > 0 && after === 0) {
      bucket.churned += before
    } else if (after > before) {
      bucket.expansion += after - before
    } else if (after < before) {
      bucket.contraction += before - after
    }
  }

  return {
    previousMrr: round2(previousMrr),
    currentMrr: round2(currentMrr),
    new: round2(bucket.new),
    reactivation: round2(bucket.reactivation),
    expansion: round2(bucket.expansion),
    contraction: round2(bucket.contraction),
    churned: round2(bucket.churned),
    net: round2(currentMrr - previousMrr),
  }
}

/** A before/after pair with absolute and proportional change (0.25 = +25%). */
export interface Change {
  previous: number
  current: number
  delta: number
  /** Proportional change as a ratio; from a zero base it's 1 (or 0 if still 0). */
  pct: number
}

export function change(previous: number, current: number): Change {
  const delta = round2(current - previous)
  const pct = previous === 0 ? (current === 0 ? 0 : 1) : round2(delta / previous)
  return { previous: round2(previous), current: round2(current), delta, pct }
}

/** Period-over-period growth of the headline billing metrics. */
export interface MetricsGrowth {
  mrr: Change
  arr: Change
  active: Change
}

export function growth(previous: BillingMetrics, current: BillingMetrics): MetricsGrowth {
  return {
    mrr: change(previous.mrr, current.mrr),
    arr: change(previous.arr, current.arr),
    active: change(previous.active, current.active),
  }
}
