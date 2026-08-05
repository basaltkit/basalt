import { MachizeError, parseDuration, type HookBus } from '@machize/core'
import type { BillingGateway, WebhookEvent } from './gateway.js'
import {
  featureLimit,
  isMeter,
  planPrice,
  UnknownPlanError,
  type BillingPeriod,
  type PlanDefinition,
  type Plans,
} from './plans.js'
import {
  MemorySubscriptionStore,
  MemoryUsageStore,
  MemoryWebhookStore,
  type SubscriptionRecord,
  type SubscriptionStore,
  type UsageStore,
  type WebhookStore,
} from './stores.js'

export class NotSubscribedError extends MachizeError {
  readonly status = 402
  constructor() {
    super('BILLING_SUBSCRIPTION_REQUIRED', 'An active subscription is required.')
  }
}

export class FeatureUnavailableError extends MachizeError {
  readonly status = 403
  constructor(feature: string) {
    super('BILLING_FEATURE_UNAVAILABLE', `The feature "${feature}" is not available on this plan.`)
  }
}

export class QuotaExceededError extends MachizeError {
  readonly status = 402
  constructor(feature: string, remaining: number) {
    super(
      'BILLING_QUOTA_EXCEEDED',
      `Quota exceeded for "${feature}" (remaining: ${remaining}).`,
    )
  }
}

export interface SubscriptionsOptions {
  plans: Plans
  store?: SubscriptionStore
  usage?: UsageStore
  gateway?: BillingGateway
  /** Webhook dedupe store. Default: in-memory (per-process). */
  webhooks?: WebhookStore
  /** Plan applied to billables without a subscription (e.g. 'free'). */
  fallbackPlan?: string
  hooks?: HookBus
}

/** Monthly bucket for meters — resets every calendar month. */
const currentMeterPeriod = (): string => new Date().toISOString().slice(0, 7)

export class Subscriptions {
  private readonly plans: Plans
  private readonly store: SubscriptionStore
  private readonly usage: UsageStore
  private readonly gateway: BillingGateway | undefined
  private readonly fallbackPlan: string | undefined
  private readonly hooks: HookBus | undefined
  private readonly webhooks: WebhookStore

  constructor(options: SubscriptionsOptions) {
    this.plans = options.plans
    this.store = options.store ?? new MemorySubscriptionStore()
    this.usage = options.usage ?? new MemoryUsageStore()
    this.gateway = options.gateway
    this.webhooks = options.webhooks ?? new MemoryWebhookStore()
    this.fallbackPlan = options.fallbackPlan
    this.hooks = options.hooks
    if (options.fallbackPlan) this.plan(options.fallbackPlan) // fail fast on typos
  }

  plan(name: string): PlanDefinition {
    const plan = this.plans[name]
    if (!plan) throw new UnknownPlanError(name)
    return plan
  }

  async subscribe(
    billableId: string,
    planName: string,
    options: { period?: BillingPeriod } = {},
  ): Promise<SubscriptionRecord> {
    const plan = this.plan(planName)
    const period = options.period ?? 'monthly'
    const price = planPrice(plan, period)

    const record: SubscriptionRecord = {
      billableId,
      plan: planName,
      period,
      status: plan.trial ? 'trialing' : 'active',
      ...(plan.trial ? { trialEndsAt: Date.now() + parseDuration(plan.trial) } : {}),
    }
    // Free plans and trials never touch the gateway; paid plans do.
    // KNOWN LIMITATION (see KNOWN_LIMITATIONS.md #3): trials never create a
    // gateway subscription, so trial->paid conversion is not wired yet.
    if (this.gateway && typeof price === 'number' && price > 0 && !plan.trial) {
      const { gatewayRef } = await this.gateway.createSubscription({
        billableId,
        plan: planName,
        period,
        price,
      })
      record.gatewayRef = gatewayRef
    }
    await this.store.save(record)
    await this.hooks?.emit('billing:subscribed', { subscription: record })
    return record
  }

  async get(billableId: string): Promise<SubscriptionRecord | null> {
    return this.store.get(billableId)
  }

  /** Active = status active, or trialing with the trial still running. */
  async subscribed(billableId: string, plan?: string): Promise<boolean> {
    const record = await this.store.get(billableId)
    if (!record) return false
    if (plan && record.plan !== plan) return false
    return this.isActive(record)
  }

  async onTrial(billableId: string): Promise<boolean> {
    const record = await this.store.get(billableId)
    return (
      record?.status === 'trialing' &&
      record.trialEndsAt !== undefined &&
      record.trialEndsAt > Date.now()
    )
  }

  async swap(billableId: string, planName: string): Promise<SubscriptionRecord> {
    const record = await this.store.get(billableId)
    if (!record || !this.isActive(record)) throw new NotSubscribedError()
    this.plan(planName)
    const from = record.plan
    record.plan = planName
    await this.store.save(record)
    await this.hooks?.emit('billing:swapped', { subscription: record, from })
    return record
  }

  async cancel(
    billableId: string,
    options: { atPeriodEnd?: boolean } = {},
  ): Promise<SubscriptionRecord> {
    const record = await this.store.get(billableId)
    if (!record) throw new NotSubscribedError()
    const atPeriodEnd = options.atPeriodEnd ?? true

    if (record.gatewayRef) {
      await this.gateway?.cancelSubscription(record.gatewayRef, { atPeriodEnd })
    }
    if (atPeriodEnd) {
      record.cancelAtPeriodEnd = true
    } else {
      record.status = 'canceled'
      record.canceledAt = Date.now()
    }
    await this.store.save(record)
    await this.hooks?.emit('billing:canceled', { subscription: record })
    return record
  }

  async resume(billableId: string): Promise<SubscriptionRecord> {
    const record = await this.store.get(billableId)
    if (!record || record.status === 'canceled') throw new NotSubscribedError()
    record.cancelAtPeriodEnd = false
    await this.store.save(record)
    return record
  }

  /** Feature checks and consumption, Soulbscription-style. */
  features(billableId: string) {
    const resolve = async (): Promise<PlanDefinition | null> => {
      const record = await this.store.get(billableId)
      if (record && this.isActive(record)) return this.plan(record.plan)
      return this.fallbackPlan ? this.plan(this.fallbackPlan) : null
    }
    const periodKey = (plan: PlanDefinition, feature: string): string =>
      isMeter(plan.features[feature]) ? currentMeterPeriod() : 'lifetime'

    return {
      can: async (feature: string): Promise<boolean> => {
        const plan = await resolve()
        return plan !== null && featureLimit(plan.features[feature]) > 0
      },
      limit: async (feature: string): Promise<number> => {
        const plan = await resolve()
        return plan ? featureLimit(plan.features[feature]) : 0
      },
      usage: async (feature: string): Promise<number> => {
        const plan = await resolve()
        if (!plan) return 0
        return this.usage.get(billableId, feature, periodKey(plan, feature))
      },
      remaining: async (feature: string): Promise<number> => {
        const plan = await resolve()
        if (!plan) return 0
        const limit = featureLimit(plan.features[feature])
        if (limit === Number.POSITIVE_INFINITY) return limit
        const used = await this.usage.get(billableId, feature, periodKey(plan, feature))
        return Math.max(0, limit - used)
      },
      consume: async (feature: string, amount = 1): Promise<number> => {
        const plan = await resolve()
        if (!plan) throw new FeatureUnavailableError(feature)
        const limit = featureLimit(plan.features[feature])
        if (limit === 0) throw new FeatureUnavailableError(feature)

        const key = periodKey(plan, feature)
        // Unlimited features are just tracked; limited ones go through the
        // store's atomic check-and-increment so a quota is never overshot.
        if (limit === Number.POSITIVE_INFINITY) {
          return this.usage.increment(billableId, feature, key, amount)
        }
        const result = await this.usage.consume(billableId, feature, key, amount, limit)
        if (!result.applied) {
          throw new QuotaExceededError(feature, Math.max(0, limit - result.used))
        }
        return result.used
      },
    }
  }

  /**
   * Applies a gateway webhook: idempotent by event id, updates local state
   * and emits domain hooks. Local state is the read model — feature checks
   * never call the gateway.
   */
  async handleWebhook(event: WebhookEvent): Promise<boolean> {
    // Claim the event id durably (Redis SET NX in production). A false claim
    // means it was already processed — skip.
    const fresh = await this.webhooks.markProcessed(event.id)
    if (!fresh) return false

    try {
      const record = await this.store.get(event.billableId)
      if (record) {
        if (event.type === 'subscription.canceled') {
          record.status = 'canceled'
          record.canceledAt = Date.now()
        } else if (event.type === 'payment.failed') {
          record.status = 'past_due'
        } else if (event.type === 'payment.succeeded') {
          record.status = 'active'
          record.cancelAtPeriodEnd = false
        }
        await this.store.save(record)
      }
    } catch (error) {
      // Persisting the state change failed — release the claim so the
      // gateway's retry can reprocess instead of being silently deduped.
      await this.webhooks.release(event.id)
      throw error
    }

    await this.hooks?.emit('billing:webhook', { event })
    return true
  }

  /** Maintenance (run from the scheduler): settles expired trials. */
  async expireTrials(): Promise<SubscriptionRecord[]> {
    const expired: SubscriptionRecord[] = []
    for (const record of await this.store.all()) {
      if (
        record.status === 'trialing' &&
        record.trialEndsAt !== undefined &&
        record.trialEndsAt <= Date.now()
      ) {
        const price = planPrice(this.plan(record.plan), record.period)
        record.status = typeof price === 'number' && price === 0 ? 'active' : 'past_due'
        await this.store.save(record)
        expired.push(record)
        await this.hooks?.emit('billing:trial_expired', { subscription: record })
      }
    }
    return expired
  }

  private isActive(record: SubscriptionRecord): boolean {
    if (record.status === 'active') return true
    return (
      record.status === 'trialing' &&
      record.trialEndsAt !== undefined &&
      record.trialEndsAt > Date.now()
    )
  }
}
