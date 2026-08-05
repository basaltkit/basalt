import type { BillingPeriod } from './plans.js'

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled'

export interface SubscriptionRecord {
  /** The billable entity — the tenant id by convention. */
  billableId: string
  plan: string
  period: BillingPeriod
  status: SubscriptionStatus
  trialEndsAt?: number
  cancelAtPeriodEnd?: boolean
  canceledAt?: number
  /** Reference in the payment gateway (e.g. Stripe subscription id). */
  gatewayRef?: string
}

export interface SubscriptionStore {
  get(billableId: string): Promise<SubscriptionRecord | null>
  save(record: SubscriptionRecord): Promise<void>
  all(): Promise<SubscriptionRecord[]>
}

export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly records = new Map<string, SubscriptionRecord>()

  async get(billableId: string): Promise<SubscriptionRecord | null> {
    return this.records.get(billableId) ?? null
  }

  async save(record: SubscriptionRecord): Promise<void> {
    this.records.set(record.billableId, { ...record })
  }

  async all(): Promise<SubscriptionRecord[]> {
    return [...this.records.values()].map((record) => ({ ...record }))
  }
}

/** Usage counters: `periodKey` is 'lifetime' or 'YYYY-MM' for meters. */
export interface UsageStore {
  get(billableId: string, feature: string, periodKey: string): Promise<number>
  increment(
    billableId: string,
    feature: string,
    periodKey: string,
    amount: number,
  ): Promise<number>
}

export class MemoryUsageStore implements UsageStore {
  private readonly counters = new Map<string, number>()

  private key(billableId: string, feature: string, periodKey: string): string {
    return `${billableId}::${feature}::${periodKey}`
  }

  async get(billableId: string, feature: string, periodKey: string): Promise<number> {
    return this.counters.get(this.key(billableId, feature, periodKey)) ?? 0
  }

  async increment(
    billableId: string,
    feature: string,
    periodKey: string,
    amount: number,
  ): Promise<number> {
    const key = this.key(billableId, feature, periodKey)
    const total = (this.counters.get(key) ?? 0) + amount
    this.counters.set(key, total)
    return total
  }
}
