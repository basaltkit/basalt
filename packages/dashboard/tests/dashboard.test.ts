import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineResource } from '@basaltkit/admin'
import { definePlans } from '@basaltkit/subscriptions'
import type { SubscriptionRecord } from '@basaltkit/subscriptions'
import {
  churnRate,
  computeBillingMetrics,
  defineDashboard,
  metricsSection,
  queueSection,
  resourceSection,
  summarizeAudit,
  summarizeQueue,
} from '../src/index.js'

const plans = definePlans({
  free: { price: 0, features: {} },
  pro: { price: { monthly: 30, yearly: 300 }, features: {} },
  scale: { price: 'custom', features: {} },
})

const sub = (over: Partial<SubscriptionRecord>): SubscriptionRecord => ({
  billableId: 't',
  plan: 'pro',
  period: 'monthly',
  status: 'active',
  ...over,
})

describe('computeBillingMetrics', () => {
  it('sums MRR from active subs, normalizing yearly to monthly', () => {
    const metrics = computeBillingMetrics(
      [
        sub({ billableId: 'a', plan: 'pro', period: 'monthly', status: 'active' }), // +30
        sub({ billableId: 'b', plan: 'pro', period: 'yearly', status: 'active' }), // +25
        sub({ billableId: 'c', plan: 'pro', status: 'trialing' }), // trial → 0 but counted
        sub({ billableId: 'd', plan: 'free', status: 'active' }), // +0
        sub({ billableId: 'e', plan: 'scale', status: 'active' }), // custom → 0
        sub({ billableId: 'f', plan: 'pro', status: 'past_due' }),
        sub({ billableId: 'g', plan: 'pro', status: 'canceled' }),
      ],
      plans,
    )

    expect(metrics.mrr).toBe(55)
    expect(metrics.arr).toBe(660)
    expect(metrics).toMatchObject({ active: 4, trialing: 1, pastDue: 1, canceled: 1 })
    expect(metrics.byPlan).toEqual({ pro: 5, free: 1, scale: 1 })
  })

  it('churnRate is lost ÷ start, guarding divide-by-zero', () => {
    expect(churnRate(5, 100)).toBe(0.05)
    expect(churnRate(3, 0)).toBe(0)
  })
})

describe('summaries', () => {
  it('summarizeQueue totals and flags dead-letter health', () => {
    expect(summarizeQueue({ waiting: 2, active: 1, failed: 3 })).toEqual({
      waiting: 2,
      active: 1,
      completed: 0,
      failed: 3,
      delayed: 0,
      total: 6,
      healthy: false,
    })
    expect(summarizeQueue({ completed: 10 }).healthy).toBe(true)
  })

  it('summarizeAudit groups by event, most frequent first', () => {
    expect(
      summarizeAudit([
        { event: 'auth:login' },
        { event: 'billing:subscribed' },
        { event: 'auth:login' },
      ]),
    ).toEqual([
      { event: 'auth:login', count: 2 },
      { event: 'billing:subscribed', count: 1 },
    ])
  })
})

describe('defineDashboard', () => {
  it('assembles sections and a nav model', () => {
    const projects = defineResource({ name: 'projects', schema: z.object({ id: z.string(), name: z.string() }) })
    const dashboard = defineDashboard({
      title: 'Basalt Admin',
      sections: [
        metricsSection({ icon: 'gauge' }),
        resourceSection(projects, { icon: 'folder' }),
        queueSection(),
      ],
    })

    expect(dashboard.title).toBe('Basalt Admin')
    expect(dashboard.nav()).toEqual([
      { key: 'overview', label: 'Overview', icon: 'gauge' },
      { key: 'projects', label: 'Projects', icon: 'folder' },
      { key: 'queues', label: 'Queues' },
    ])
    expect(dashboard.section('projects')?.resource).toBe(projects)
    expect(dashboard.section('missing')).toBeUndefined()
  })
})
