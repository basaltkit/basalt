import type { PlanDefinition, SubscriptionRecord } from '@basaltkit/subscriptions'
import {
  churnRate,
  computeBillingMetrics,
  summarizeAudit,
  summarizeQueue,
  type QueueCounts,
  type QueueSummary,
} from './metrics.js'

/** Semantic tone a shell maps to colour (green/amber/red/neutral). */
export type KpiTone = 'default' | 'positive' | 'warning' | 'critical'

/** A single headline number for the Overview page. */
export interface Kpi {
  label: string
  value: string
  hint?: string
  tone?: KpiTone
}

/** The fully-assembled Overview view-model a shell renders directly. */
export interface OverviewModel {
  kpis: Kpi[]
  byPlan: { plan: string; count: number }[]
  byStatus: { status: string; count: number }[]
  /** Present when queue counts were supplied. */
  queue?: QueueSummary
  /** Top audit events, present when an audit log was supplied. */
  topEvents?: { event: string; count: number }[]
}

export interface OverviewInput {
  subscriptions: SubscriptionRecord[]
  plans: Record<string, PlanDefinition>
  /** Job counts → a Queue health KPI + the queue summary. */
  queue?: QueueCounts
  /** Recent audit entries → the "top events" list. */
  audit?: { event: string }[]
  /** Active subscriptions at the period start → a Churn KPI. */
  activeAtStart?: number
  /** Currency prefix for money KPIs. Default `$`. */
  currency?: string
}

/** Groups an integer's thousands (locale-independent, for stable output). */
function group(n: number): string {
  const [whole, frac] = String(n).split('.')
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac ? `${grouped}.${frac}` : grouped
}

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`

/**
 * Assembles the Overview page from a snapshot: billing metrics (MRR/ARR/counts),
 * optional churn, and optional queue health — into KPI cards plus breakdowns for
 * charts. Pure: a shell renders the returned model, deciding nothing itself.
 */
export function buildOverview(input: OverviewInput): OverviewModel {
  const currency = input.currency ?? '$'
  const money = (value: number): string => `${currency}${group(value)}`
  const m = computeBillingMetrics(input.subscriptions, input.plans)

  const kpis: Kpi[] = [
    { label: 'MRR', value: money(m.mrr), hint: 'monthly recurring' },
    { label: 'ARR', value: money(m.arr), hint: 'annual run rate' },
    { label: 'Active', value: String(m.active), hint: 'paying subscriptions', tone: m.active > 0 ? 'positive' : 'default' },
    { label: 'Trialing', value: String(m.trialing), hint: 'in trial' },
    { label: 'Past due', value: String(m.pastDue), hint: 'payment failed', tone: m.pastDue > 0 ? 'warning' : 'default' },
  ]

  if (input.activeAtStart !== undefined) {
    const churn = churnRate(m.canceled, input.activeAtStart)
    kpis.push({ label: 'Churn', value: pct(churn), hint: 'this period', tone: churn > 0.05 ? 'warning' : 'default' })
  }

  let queue: QueueSummary | undefined
  if (input.queue) {
    queue = summarizeQueue(input.queue)
    kpis.push({
      label: 'Failed jobs',
      value: String(queue.failed),
      hint: 'dead-letter',
      tone: queue.failed > 0 ? 'critical' : 'positive',
    })
  }

  const byPlan = Object.entries(m.byPlan)
    .map(([plan, count]) => ({ plan, count }))
    .sort((a, b) => b.count - a.count || a.plan.localeCompare(b.plan))

  const byStatus = [
    { status: 'active', count: m.active },
    { status: 'trialing', count: m.trialing },
    { status: 'past_due', count: m.pastDue },
    { status: 'canceled', count: m.canceled },
  ].filter((s) => s.count > 0)

  return {
    kpis,
    byPlan,
    byStatus,
    ...(queue ? { queue } : {}),
    ...(input.audit ? { topEvents: summarizeAudit(input.audit).slice(0, 5) } : {}),
  }
}
