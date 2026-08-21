import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineResource } from '@basaltkit/admin'
import type { PlanDefinition, SubscriptionRecord } from '@basaltkit/subscriptions'
import { buildOverview, standardDashboard } from '../src/index.js'

const plans: Record<string, PlanDefinition> = {
  free: { price: 0, features: {} },
  pro: { price: { monthly: 29, yearly: 290 }, features: {} },
  scale: { price: { monthly: 99, yearly: 990 }, features: {} },
}
const subs: SubscriptionRecord[] = [
  { billableId: 'a', plan: 'scale', period: 'monthly', status: 'active' },
  { billableId: 'b', plan: 'pro', period: 'yearly', status: 'active' },
  { billableId: 'c', plan: 'pro', period: 'monthly', status: 'active' },
  { billableId: 'd', plan: 'pro', period: 'monthly', status: 'trialing' },
  { billableId: 'e', plan: 'pro', period: 'monthly', status: 'past_due' },
  { billableId: 'f', plan: 'free', period: 'monthly', status: 'canceled' },
]

const kpi = (m: ReturnType<typeof buildOverview>, label: string) => m.kpis.find((k) => k.label === label)!

describe('buildOverview', () => {
  it('assembles money + count KPIs with grouped currency', () => {
    const m = buildOverview({ subscriptions: subs, plans, currency: '$' })
    // MRR = 99 + 290/12 + 29 = 99 + 24.17 + 29 = 152.17
    expect(kpi(m, 'MRR').value).toBe('$152.17')
    expect(kpi(m, 'ARR').value).toBe('$1,826')
    expect(kpi(m, 'Active').value).toBe('3')
    expect(kpi(m, 'Active').tone).toBe('positive')
    expect(kpi(m, 'Trialing').value).toBe('1')
  })

  it('flags past-due as a warning only when non-zero', () => {
    expect(kpi(buildOverview({ subscriptions: subs, plans }), 'Past due').tone).toBe('warning')
    const clean = buildOverview({ subscriptions: subs.filter((s) => s.status !== 'past_due'), plans })
    expect(kpi(clean, 'Past due').tone).toBe('default')
  })

  it('adds a churn KPI when activeAtStart is given', () => {
    const m = buildOverview({ subscriptions: subs, plans, activeAtStart: 4 }) // 1 canceled / 4 = 25%
    expect(kpi(m, 'Churn').value).toBe('25%')
    expect(kpi(m, 'Churn').tone).toBe('warning')
  })

  it('adds a critical Failed-jobs KPI and the queue summary', () => {
    const m = buildOverview({ subscriptions: subs, plans, queue: { failed: 2, waiting: 5 } })
    expect(kpi(m, 'Failed jobs').value).toBe('2')
    expect(kpi(m, 'Failed jobs').tone).toBe('critical')
    expect(m.queue).toMatchObject({ failed: 2, waiting: 5, healthy: false })
  })

  it('sorts byPlan and filters byStatus to non-zero, and tops events', () => {
    const m = buildOverview({
      subscriptions: subs,
      plans,
      audit: [{ event: 'login' }, { event: 'login' }, { event: 'delete' }],
    })
    expect(m.byPlan[0]).toEqual({ plan: 'pro', count: 4 })
    expect(m.byStatus.map((s) => s.status)).toEqual(['active', 'trialing', 'past_due', 'canceled'])
    expect(m.topEvents![0]).toEqual({ event: 'login', count: 2 })
  })
})

describe('standardDashboard', () => {
  const projects = defineResource({ name: 'projects', schema: z.object({ id: z.string(), name: z.string() }), columns: ['name'] })

  it('assembles Overview → resources → Queues → Audit in order', () => {
    const d = standardDashboard({ title: 'Ops', resources: [projects], queues: true, audit: true })
    expect(d.title).toBe('Ops')
    expect(d.nav().map((n) => n.key)).toEqual(['overview', 'projects', 'queues', 'audit'])
    expect(d.section('overview')!.kind).toBe('metrics')
    expect(d.section('projects')!.kind).toBe('resource')
  })

  it('omits optional sections and can drop the billing overview', () => {
    const d = standardDashboard({ resources: [projects], billing: false })
    expect(d.nav().map((n) => n.key)).toEqual(['projects'])
  })
})
