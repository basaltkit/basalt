// Types only — erased at build time. This keeps @basaltkit/dashboard free of a
// RUNTIME dependency on @basaltkit/subscriptions (which pulls @basaltkit/fastify
// and @basaltkit/core's AsyncLocalStorage), so the metrics functions are
// browser-safe. planPrice is inlined below for the same reason.
import type { BillingPeriod, PlanDefinition, SubscriptionRecord } from '@basaltkit/subscriptions'

/** Numeric monthly/yearly price for a plan, or 'custom'. Mirrors @basaltkit/subscriptions' planPrice. */
function planPrice(plan: PlanDefinition, period: BillingPeriod): number | 'custom' {
  if (plan.price === 'custom') return 'custom'
  return typeof plan.price === 'number' ? plan.price : plan.price[period]
}

export interface BillingMetrics {
  /** Monthly recurring revenue from active subscriptions (yearly prices ÷ 12). */
  mrr: number
  /** Annual run rate (mrr × 12). */
  arr: number
  active: number
  trialing: number
  pastDue: number
  canceled: number
  /** Subscription count per plan (all statuses). */
  byPlan: Record<string, number>
}

const round2 = (value: number): number => Math.round(value * 100) / 100

/**
 * Computes billing metrics from a snapshot of subscriptions and the plan
 * catalog. MRR counts only active subscriptions with a numeric price; trials
 * and custom-priced plans contribute 0 (they are not recurring revenue yet).
 */
export function computeBillingMetrics(
  subscriptions: SubscriptionRecord[],
  plans: Record<string, PlanDefinition>,
): BillingMetrics {
  let mrr = 0
  const byPlan: Record<string, number> = {}
  const counts = { active: 0, trialing: 0, pastDue: 0, canceled: 0 }

  for (const sub of subscriptions) {
    byPlan[sub.plan] = (byPlan[sub.plan] ?? 0) + 1
    if (sub.status === 'active') counts.active++
    else if (sub.status === 'trialing') counts.trialing++
    else if (sub.status === 'past_due') counts.pastDue++
    else if (sub.status === 'canceled') counts.canceled++

    if (sub.status === 'active') {
      const plan = plans[sub.plan]
      if (plan) {
        const price = planPrice(plan, sub.period)
        if (typeof price === 'number') {
          mrr += sub.period === 'yearly' ? price / 12 : price
        }
      }
    }
  }

  return {
    mrr: round2(mrr),
    arr: round2(mrr * 12),
    active: counts.active,
    trialing: counts.trialing,
    pastDue: counts.pastDue,
    canceled: counts.canceled,
    byPlan,
  }
}

/**
 * Churn rate over a period: customers lost ÷ customers at the start.
 * Returns a fraction in [0, 1]; 0 when there were none at the start.
 */
export function churnRate(canceledInPeriod: number, activeAtStart: number): number {
  if (activeAtStart <= 0) return 0
  return round2(canceledInPeriod / activeAtStart)
}

// --- queue + audit summaries --------------------------------------------

export interface QueueCounts {
  waiting?: number
  active?: number
  completed?: number
  failed?: number
  delayed?: number
}

export interface QueueSummary extends Required<QueueCounts> {
  total: number
  /** True when nothing is in the failed (dead-letter) state. */
  healthy: boolean
}

export function summarizeQueue(counts: QueueCounts): QueueSummary {
  const full = {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
  }
  const total = full.waiting + full.active + full.completed + full.failed + full.delayed
  return { ...full, total, healthy: full.failed === 0 }
}

/** Groups audit-like entries by event name, most frequent first. */
export function summarizeAudit(entries: { event: string }[]): { event: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1)
  return [...counts.entries()]
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event))
}
