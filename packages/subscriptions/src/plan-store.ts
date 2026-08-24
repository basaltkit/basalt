import type { PlanDefinition, Plans } from './plans.js'

/**
 * Persisting the plan catalog. Plans are consumed as a synchronous `Plans`
 * object (by `planPrice`, feature checks and the route guards), so the durable
 * source of truth lives here and is **loaded once at boot** into that object —
 * edit a plan in the store, restart to apply. A `PlanStore` is the neutral
 * interface; back it with your database (see the per-package prisma/sqlite
 * stores) or use the in-memory one for tests/seeds.
 */
export interface StoredPlan {
  /** Catalog key, e.g. `'pro'`. */
  name: string
  definition: PlanDefinition
}

export interface PlanStore {
  all(): Promise<StoredPlan[]>
  get(name: string): Promise<StoredPlan | null>
  save(plan: StoredPlan): Promise<void>
}

/** Turn a `definePlans({...})` object into rows — handy for seeding a store. */
export function plansToStored(plans: Plans): StoredPlan[] {
  return Object.entries(plans).map(([name, definition]) => ({ name, definition }))
}

/**
 * Build a `Plans` catalog from a store — call at boot and pass the result to
 * `subscriptionsPlugin({ plans })`.
 *
 * ```ts
 * const plans = await loadPlans(planStore)
 * subscriptionsPlugin({ plans, fallbackPlan: 'free', ...stores })
 * ```
 */
export async function loadPlans(store: PlanStore): Promise<Plans> {
  const catalog: Record<string, PlanDefinition> = {}
  for (const { name, definition } of await store.all()) catalog[name] = definition
  return catalog
}

/** In-memory plan store — seed it from a `definePlans` object; swap for a DB-backed one in production. */
export class MemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, StoredPlan>()

  constructor(seed?: Plans) {
    if (seed) for (const plan of plansToStored(seed)) this.plans.set(plan.name, plan)
  }
  async all(): Promise<StoredPlan[]> {
    return [...this.plans.values()].map((p) => ({ ...p }))
  }
  async get(name: string): Promise<StoredPlan | null> {
    const found = this.plans.get(name)
    return found ? { ...found } : null
  }
  async save(plan: StoredPlan): Promise<void> {
    this.plans.set(plan.name, { ...plan })
  }
}
