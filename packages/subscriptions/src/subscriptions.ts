import { BasaltError, parseDuration, type HookBus } from '@basaltkit/core'
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
  assertUsageAmount,
  MemorySubscriptionStore,
  MemoryUsageStore,
  MemoryWebhookStore,
  type SubscriptionRecord,
  type SubscriptionStore,
  type UsageStore,
  type WebhookStore,
} from './stores.js'

export class NotSubscribedError extends BasaltError {
  readonly status = 402
  constructor() {
    super('BILLING_SUBSCRIPTION_REQUIRED', 'An active subscription is required.')
  }
}

export class FeatureUnavailableError extends BasaltError {
  readonly status = 403
  constructor(feature: string) {
    super('BILLING_FEATURE_UNAVAILABLE', `The feature "${feature}" is not available on this plan.`)
  }
}

export class QuotaExceededError extends BasaltError {
  readonly status = 402
  constructor(feature: string, remaining: number) {
    super(
      'BILLING_QUOTA_EXCEEDED',
      `Quota exceeded for "${feature}" (remaining: ${remaining}).`,
    )
  }
}

/**
 * A plan change would grant a paid plan without anything being charged: the
 * subscription is not backed by a gateway subscription, so there is nothing to
 * swap (and prorate) at the gateway. Start a `checkout()` for the paid plan
 * instead — or, when payment really is collected elsewhere (manual invoicing,
 * reference payments, a sales-led deal), say so with `swap(..., { allowUnpaid: true })`.
 */
export class PaymentRequiredError extends BasaltError {
  readonly status = 402
  constructor(plan: string) {
    super(
      'BILLING_PAYMENT_REQUIRED',
      `Switching to the paid plan "${plan}" requires a payment: this subscription has no gateway ` +
        'subscription to charge. Use checkout(), or pass { allowUnpaid: true } when payment is collected elsewhere.',
    )
  }
}

/** A billing action needs a gateway (or gateway capability) that isn't configured. */
export class GatewayUnsupportedError extends BasaltError {
  readonly status = 501
  constructor(capability: string) {
    super('BILLING_GATEWAY_UNSUPPORTED', `The billing gateway does not support "${capability}".`)
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
  /** Clock in epoch ms (tests, simulations). Default: `Date.now`. */
  now?: () => number
}

/** Monthly bucket for meters — resets every calendar month (UTC). */
const meterPeriod = (now: number): string => new Date(now).toISOString().slice(0, 7)

const trialDaysOf = (trial: PlanDefinition['trial']): number | undefined =>
  trial ? Math.max(1, Math.ceil(parseDuration(trial) / 86_400_000)) : undefined

export class Subscriptions {
  private readonly plans: Plans
  private readonly store: SubscriptionStore
  private readonly usage: UsageStore
  private readonly gateway: BillingGateway | undefined
  private readonly fallbackPlan: string | undefined
  private readonly hooks: HookBus | undefined
  private readonly webhooks: WebhookStore
  private readonly now: () => number

  constructor(options: SubscriptionsOptions) {
    this.plans = options.plans
    this.store = options.store ?? new MemorySubscriptionStore()
    this.usage = options.usage ?? new MemoryUsageStore()
    this.gateway = options.gateway
    this.webhooks = options.webhooks ?? new MemoryWebhookStore()
    this.fallbackPlan = options.fallbackPlan
    this.hooks = options.hooks
    this.now = options.now ?? (() => Date.now())
    if (options.fallbackPlan) this.plan(options.fallbackPlan) // fail fast on typos
  }

  plan(name: string): PlanDefinition {
    // Own keys only: `plans['constructor']` / `plans['__proto__']` resolve
    // through the prototype and must not count as a plan.
    const plan = Object.hasOwn(this.plans, name) ? this.plans[name] : undefined
    if (!plan || typeof plan !== 'object') throw new UnknownPlanError(name)
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
      ...(plan.trial ? { trialEndsAt: this.now() + parseDuration(plan.trial) } : {}),
    }
    // Paid plans go through the gateway — with a trial period when the plan
    // has one, so the gateway runs the trial and drives the trial-end charge
    // via webhook (invoice.paid → active, invoice.payment_failed → past_due).
    // Free plans never touch the gateway.
    if (this.gateway && typeof price === 'number' && price > 0) {
      const trialDays = trialDaysOf(plan.trial)
      const { gatewayRef } = await this.gateway.createSubscription({
        billableId,
        plan: planName,
        period,
        price,
        ...(trialDays !== undefined ? { trialDays } : {}),
      })
      record.gatewayRef = gatewayRef
    }
    await this.store.save(record)
    await this.hooks?.emit('billing:subscribed', { subscription: record })
    return record
  }

  /**
   * Starts a hosted Checkout flow for a paid plan. Records the intended
   * subscription locally as `incomplete` — it becomes `active` when the
   * gateway confirms payment via webhook (`payment.succeeded`). Returns the
   * URL to redirect the customer to.
   */
  async checkout(
    billableId: string,
    planName: string,
    options: { period?: BillingPeriod; successUrl: string; cancelUrl: string },
  ): Promise<{ url: string }> {
    const plan = this.plan(planName)
    if (!this.gateway?.createCheckoutSession) throw new GatewayUnsupportedError('checkout')
    const period = options.period ?? 'monthly'
    const trialDays = trialDaysOf(plan.trial)

    const session = await this.gateway.createCheckoutSession({
      billableId,
      plan: planName,
      period,
      successUrl: options.successUrl,
      cancelUrl: options.cancelUrl,
      ...(trialDays !== undefined ? { trialDays } : {}),
    })

    // Never overwrite a live subscription with a mere checkout *intent*: an
    // abandoned checkout must not change the plan, drop the gateway ref, or
    // reset the status (that combination allowed plan escalation via the next
    // legitimately-signed renewal webhook). The intent rides in pendingPlan /
    // pendingPeriod and is only promoted by handleWebhook when the gateway
    // confirms payment with a NEW gateway ref.
    const existing = await this.store.get(billableId)
    const record: SubscriptionRecord = existing
      ? { ...existing, pendingPlan: planName, pendingPeriod: period }
      : { billableId, plan: planName, period, status: 'incomplete' }
    await this.store.save(record)
    await this.hooks?.emit('billing:checkout_started', { billableId, plan: planName, url: session.url })
    return { url: session.url }
  }

  /**
   * Opens a Customer Portal session for self-service billing (update card,
   * change plan, cancel). Returns the URL to redirect the customer to.
   */
  async portal(billableId: string, options: { returnUrl: string }): Promise<{ url: string }> {
    if (!this.gateway?.createPortalSession) throw new GatewayUnsupportedError('portal')
    return this.gateway.createPortalSession({ billableId, returnUrl: options.returnUrl })
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
      record.trialEndsAt > this.now()
    )
  }

  /**
   * Changes the plan on an active subscription. When the subscription is
   * gateway-backed, the change is pushed to the gateway with proration so the
   * customer is credited/charged the mid-cycle difference (pass
   * `{ prorate: false }` to switch at the next renewal with no immediate
   * settlement).
   *
   * Fails closed when nothing would be charged: a subscription without a
   * gateway subscription (a local/free one) cannot be swapped onto a paid (or
   * `'custom'`) plan — that throws {@link PaymentRequiredError}; start a
   * `checkout()` instead. Pass `{ allowUnpaid: true }` only when payment is
   * collected outside the gateway (manual invoicing, reference payments,
   * sales-led deals). A gateway-backed subscription whose gateway cannot swap
   * throws {@link GatewayUnsupportedError} rather than changing only the local
   * plan while the gateway keeps charging the old price.
   */
  async swap(
    billableId: string,
    planName: string,
    options: { prorate?: boolean; allowUnpaid?: boolean } = {},
  ): Promise<SubscriptionRecord> {
    const record = await this.store.get(billableId)
    if (!record || !this.isActive(record)) throw new NotSubscribedError()
    const target = this.plan(planName)
    const from = record.plan

    if (record.gatewayRef) {
      if (!this.gateway?.swapSubscription) throw new GatewayUnsupportedError('swap')
      await this.gateway.swapSubscription(record.gatewayRef, {
        plan: planName,
        period: record.period,
        prorationBehavior: options.prorate === false ? 'none' : 'create_prorations',
      })
    } else if (planPrice(target, record.period) !== 0 && options.allowUnpaid !== true) {
      throw new PaymentRequiredError(planName)
    }

    // Re-read after the gateway round-trip and apply the change to the CURRENT
    // state: a cancel (or webhook) that landed meanwhile must not be
    // overwritten by the stale copy read above.
    const current = (await this.store.get(billableId)) ?? record
    if (!this.isActive(current)) throw new NotSubscribedError()
    current.plan = planName
    await this.store.save(current)
    await this.hooks?.emit('billing:swapped', { subscription: current, from })
    return current
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
    // Apply to the state as it is NOW (re-read after the gateway round-trip),
    // so a concurrent swap/webhook is neither lost nor able to undo the cancel.
    const current = (await this.store.get(billableId)) ?? record
    if (atPeriodEnd) {
      current.cancelAtPeriodEnd = true
    } else {
      current.status = 'canceled'
      current.canceledAt = this.now()
    }
    await this.store.save(current)
    await this.hooks?.emit('billing:canceled', { subscription: current })
    return current
  }

  /**
   * Undoes a `cancel({ atPeriodEnd: true })`. For a gateway-backed subscription
   * the scheduled cancellation is withdrawn at the gateway too — otherwise the
   * gateway still ends the subscription at the period end and its
   * `subscription.canceled` webhook would cancel the "resumed" one locally.
   * Throws {@link GatewayUnsupportedError} when the gateway cannot resume.
   */
  async resume(billableId: string): Promise<SubscriptionRecord> {
    const record = await this.store.get(billableId)
    if (!record || record.status === 'canceled') throw new NotSubscribedError()
    if (record.cancelAtPeriodEnd === true && record.gatewayRef) {
      if (!this.gateway?.resumeSubscription) throw new GatewayUnsupportedError('resume')
      await this.gateway.resumeSubscription(record.gatewayRef)
    }
    // Apply to the state as it is NOW (re-read after the gateway round-trip).
    const current = (await this.store.get(billableId)) ?? record
    if (current.status === 'canceled') throw new NotSubscribedError()
    current.cancelAtPeriodEnd = false
    await this.store.save(current)
    return current
  }

  /** Feature checks and consumption, Soulbscription-style. */
  features(billableId: string) {
    const resolve = async (): Promise<PlanDefinition | null> => {
      const record = await this.store.get(billableId)
      if (record && this.isActive(record)) return this.plan(record.plan)
      return this.fallbackPlan ? this.plan(this.fallbackPlan) : null
    }
    // Own keys only — `features['constructor']` is not a feature.
    const valueOf = (plan: PlanDefinition, feature: string) =>
      Object.hasOwn(plan.features, feature) ? plan.features[feature] : undefined
    const periodKey = (plan: PlanDefinition, feature: string): string =>
      isMeter(valueOf(plan, feature)) ? meterPeriod(this.now()) : 'lifetime'

    return {
      can: async (feature: string): Promise<boolean> => {
        const plan = await resolve()
        return plan !== null && featureLimit(valueOf(plan, feature)) > 0
      },
      limit: async (feature: string): Promise<number> => {
        const plan = await resolve()
        return plan ? featureLimit(valueOf(plan, feature)) : 0
      },
      usage: async (feature: string): Promise<number> => {
        const plan = await resolve()
        if (!plan) return 0
        return this.usage.get(billableId, feature, periodKey(plan, feature))
      },
      remaining: async (feature: string): Promise<number> => {
        const plan = await resolve()
        if (!plan) return 0
        const limit = featureLimit(valueOf(plan, feature))
        if (limit === Number.POSITIVE_INFINITY) return limit
        const used = await this.usage.get(billableId, feature, periodKey(plan, feature))
        return Math.max(0, limit - used)
      },
      consume: async (feature: string, amount = 1): Promise<number> => {
        // A positive integer only: a negative amount refunds quota and NaN
        // disables it for good (`NaN + 1 > limit` is always false).
        assertUsageAmount(amount)
        const plan = await resolve()
        if (!plan) throw new FeatureUnavailableError(feature)
        const limit = featureLimit(valueOf(plan, feature))
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
      // An event about a DIFFERENT gateway subscription than the one on file (an
      // old, replaced subscription ending, or its final invoice failing) must not
      // touch the current one: a `subscription.canceled`/`payment.failed` is only
      // applied to the subscription it names. Events without a ref (custom
      // drivers) keep applying to the record.
      const foreign =
        record !== null &&
        record.gatewayRef !== undefined &&
        event.gatewayRef !== undefined &&
        event.gatewayRef !== record.gatewayRef
      // A cancel naming a gateway subscription we never tracked, on a record
      // that is not waiting for one (local/free, not an in-flight checkout), is
      // not about this record either.
      const untracked =
        record !== null &&
        record.gatewayRef === undefined &&
        event.gatewayRef !== undefined &&
        record.status !== 'incomplete' &&
        record.pendingPlan === undefined
      const ignore =
        (event.type === 'subscription.canceled' && (foreign || untracked)) ||
        (event.type === 'payment.failed' && foreign)
      if (record && !ignore) {
        // Is this event about a DIFFERENT gateway subscription than the one on
        // file? Computed BEFORE the ref is learned, so a first-ever ref counts
        // as new. Only such an event may complete a pending plan change — a
        // renewal of the current subscription (same ref, or no ref at all) can
        // never promote the pending plan. Fail-closed against escalation via
        // an abandoned checkout.
        const refIsNew = event.gatewayRef !== undefined && event.gatewayRef !== record.gatewayRef
        // Learn the gateway subscription id from the first event that carries
        // it — a Checkout-created subscription has no local ref until now.
        if (event.gatewayRef && !record.gatewayRef) record.gatewayRef = event.gatewayRef
        if (event.type === 'subscription.canceled') {
          record.status = 'canceled'
          record.canceledAt = this.now()
          // Remember WHICH subscription ended: later events for it (a final
          // invoice delivered after the deletion) are then recognised as stale.
          if (event.gatewayRef) record.gatewayRef = event.gatewayRef
        } else if (record.status === 'canceled' && !refIsNew) {
          // `canceled` is terminal for the subscription that was canceled. A
          // late or re-delivered payment event for it (same ref, or no ref)
          // must not revive access — only a NEW gateway subscription can.
        } else if (event.type === 'payment.failed') {
          record.status = 'past_due'
        } else if (event.type === 'payment.succeeded') {
          this.applyPaymentSucceeded(record, event, refIsNew)
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

  /**
   * `payment.succeeded` transition. A plan change is only ever taken from what
   * the gateway attests was PAID (`event.plan`, signed metadata the driver set
   * next to the charged price) — never from the latest checkout intent alone,
   * which any member can overwrite by starting another checkout (paying the
   * cheap session must not grant the expensive intent).
   */
  private applyPaymentSucceeded(record: SubscriptionRecord, event: WebhookEvent, refIsNew: boolean): void {
    const paidPlan =
      event.plan !== undefined && Object.hasOwn(this.plans, event.plan) ? event.plan : undefined
    const activate = (): void => {
      record.status = 'active'
      record.cancelAtPeriodEnd = false
      delete record.canceledAt
    }
    const adoptPaid = (plan: string): void => {
      const period =
        event.period ?? (record.pendingPlan === plan ? record.pendingPeriod : undefined) ?? record.period
      if (plan !== record.plan) delete record.trialEndsAt
      record.plan = plan
      record.period = period
      if (event.gatewayRef !== undefined) record.gatewayRef = event.gatewayRef
      if (record.pendingPlan === plan) {
        delete record.pendingPlan
        delete record.pendingPeriod
      }
    }

    // No live subscription yet (first checkout) or any more (canceled — only a
    // NEW ref reaches here): the confirmed payment defines the subscription.
    if (record.status === 'incomplete' || record.status === 'canceled') {
      if (paidPlan !== undefined) {
        adoptPaid(paidPlan)
        activate()
        return
      }
      // No attestation (custom driver): activate only when it is unambiguous
      // which plan was bought — a single intent. Otherwise fail closed and
      // leave the state for the app to reconcile from the `billing:webhook` hook.
      const ambiguous =
        record.pendingPlan !== undefined &&
        (record.pendingPlan !== record.plan ||
          (record.pendingPeriod !== undefined && record.pendingPeriod !== record.period))
      if (ambiguous) return
      if (refIsNew && event.gatewayRef !== undefined) record.gatewayRef = event.gatewayRef
      delete record.pendingPlan
      delete record.pendingPeriod
      activate()
      return
    }

    // Live subscription: only a NEW gateway subscription whose attested plan is
    // the recorded intent may change the plan. A renewal (same ref / no ref),
    // an unattested payment, or a payment for a different plan never promotes.
    if (
      refIsNew &&
      event.gatewayRef !== undefined &&
      record.pendingPlan !== undefined &&
      paidPlan === record.pendingPlan
    ) {
      adoptPaid(paidPlan)
    }
    activate()
  }

  /**
   * Maintenance (run from the scheduler): settles expired local trials.
   * Gateway-backed trials are settled by the gateway's webhook, not here.
   */
  async expireTrials(): Promise<SubscriptionRecord[]> {
    const expired: SubscriptionRecord[] = []
    for (const record of await this.store.all()) {
      if (
        record.status === 'trialing' &&
        record.trialEndsAt !== undefined &&
        record.trialEndsAt <= this.now() &&
        record.gatewayRef === undefined
      ) {
        // A plan since removed from the catalogue has no known price: settle
        // it as past_due (fail closed) instead of aborting the whole sweep and
        // leaving every later expired trial untouched.
        const plan = Object.hasOwn(this.plans, record.plan) ? this.plans[record.plan] : undefined
        const price = plan ? planPrice(plan, record.period) : 'custom'
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
      record.trialEndsAt > this.now()
    )
  }
}
