import { describe, it, expect } from 'vitest'
import { mrrMovement, growth, change } from '../src/index.js'
import type { SubscriptionRecord, PlanDefinition } from '@basaltkit/subscriptions'

const plans: Record<string, PlanDefinition> = {
  basic: { name: 'basic', price: 10, features: [] } as unknown as PlanDefinition,
  pro: { name: 'pro', price: 30, features: [] } as unknown as PlanDefinition,
  yearly: { name: 'yearly', price: { monthly: 12, yearly: 120 }, features: [] } as unknown as PlanDefinition,
  custom: { name: 'custom', price: 'custom', features: [] } as unknown as PlanDefinition,
}
const sub = (billableId: string, plan: string, status = 'active', period = 'monthly'): SubscriptionRecord =>
  ({ billableId, plan, status, period } as SubscriptionRecord)

describe('mrrMovement', () => {
  it('classifies new, expansion, contraction, churn and reactivation', () => {
    const previous = [
      sub('a', 'basic'), // stays → expansion to pro
      sub('b', 'pro'), // downgrades → contraction to basic
      sub('c', 'basic'), // churns (canceled)
      sub('d', 'basic', 'canceled'), // was $0 → reactivates
    ]
    const current = [
      sub('a', 'pro'), // 10 → 30 : +20 expansion
      sub('b', 'basic'), // 30 → 10 : 20 contraction
      sub('c', 'basic', 'canceled'), // 10 → 0 : 10 churned
      sub('d', 'basic'), // 0 → 10 : 10 reactivation
      sub('e', 'pro'), // brand new : 30 new
    ]
    const m = mrrMovement(previous, current, plans)
    expect(m.new).toBe(30)
    expect(m.expansion).toBe(20)
    expect(m.contraction).toBe(20)
    expect(m.churned).toBe(10)
    expect(m.reactivation).toBe(10)
  })

  it('the bridge balances: new + reactivation + expansion − contraction − churned === net', () => {
    const previous = [sub('a', 'basic'), sub('b', 'pro'), sub('c', 'pro')]
    const current = [sub('a', 'pro'), sub('c', 'basic'), sub('x', 'basic')]
    const m = mrrMovement(previous, current, plans)
    const bridged = m.new + m.reactivation + m.expansion - m.contraction - m.churned
    expect(round2(bridged)).toBe(m.net)
    expect(m.net).toBe(round2(m.currentMrr - m.previousMrr))
  })

  it('normalizes yearly prices to monthly and ignores custom/trial', () => {
    const m = mrrMovement([], [sub('a', 'yearly', 'active', 'yearly'), sub('b', 'custom'), sub('c', 'pro', 'trialing')], plans)
    expect(m.currentMrr).toBe(10) // 120/12; custom and trialing contribute 0
    expect(m.new).toBe(10)
  })

  it('is empty when nothing changes', () => {
    const snap = [sub('a', 'basic')]
    const m = mrrMovement(snap, snap, plans)
    expect(m).toMatchObject({ new: 0, expansion: 0, contraction: 0, churned: 0, reactivation: 0, net: 0 })
  })
})

describe('growth / change', () => {
  it('computes delta and ratio, handling a zero base', () => {
    expect(change(100, 125)).toEqual({ previous: 100, current: 125, delta: 25, pct: 0.25 })
    expect(change(0, 40)).toEqual({ previous: 0, current: 40, delta: 40, pct: 1 })
    expect(change(0, 0)).toEqual({ previous: 0, current: 0, delta: 0, pct: 0 })
  })

  it('growth wraps the headline metrics', () => {
    const g = growth(
      { mrr: 100, arr: 1200, active: 10 } as never,
      { mrr: 150, arr: 1800, active: 12 } as never,
    )
    expect(g.mrr.pct).toBe(0.5)
    expect(g.active.delta).toBe(2)
  })
})

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
