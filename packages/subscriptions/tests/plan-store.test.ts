import { describe, expect, it } from 'vitest'
import {
  definePlans,
  planPrice,
  loadPlans,
  plansToStored,
  MemoryPlanStore,
  Subscriptions,
  MemorySubscriptionStore,
  MemoryUsageStore,
} from '../src/index.js'

const seed = definePlans({
  free: { price: 0, features: { projects: 3 } },
  pro: { price: { monthly: 29, yearly: 290 }, features: { projects: 50 } },
})

describe('plan store', () => {
  it('plansToStored + MemoryPlanStore round-trip a definePlans object', async () => {
    const store = new MemoryPlanStore(seed)
    const rows = await store.all()
    expect(rows.map((r) => r.name).sort()).toEqual(['free', 'pro'])
    expect((await store.get('pro'))?.definition.price).toEqual({ monthly: 29, yearly: 290 })
    expect(plansToStored(seed)).toHaveLength(2)
  })

  it('loadPlans rebuilds a Plans catalog usable by the framework', async () => {
    const store = new MemoryPlanStore(seed)
    const plans = await loadPlans(store)
    expect(planPrice(plans.pro!, 'monthly')).toBe(29)
    expect(planPrice(plans.pro!, 'yearly')).toBe(290)

    // a store-loaded catalog drives the Subscriptions service like a static one
    const subs = new Subscriptions({
      plans,
      fallbackPlan: 'free',
      store: new MemorySubscriptionStore(),
      usage: new MemoryUsageStore(),
    })
    await subs.subscribe('acme', 'pro')
    expect((await subs.get('acme'))?.plan).toBe('pro')
  })

  it('save adds/updates a plan', async () => {
    const store = new MemoryPlanStore()
    await store.save({ name: 'enterprise', definition: { price: 'custom', features: { projects: Infinity } } })
    expect((await loadPlans(store)).enterprise?.price).toBe('custom')
  })
})
