import type { PaymentEvent, PaymentGateway, PaymentInstruction, PaymentRequest } from './payment.js'
import { PaymentLedger } from './payment.js'

/**
 * Recurring billing for gateways with **no card-on-file** (ProxyPay, AppyPay,
 * Multicaixa/EMIS): model a subscription as **one payment reference per period**.
 * Each period you issue a fresh reference; when the webhook confirms it, the
 * subscription's paid-through date is extended by one interval.
 *
 * Drive it with a scheduler: periodically call `due()` and `issueNext()` for the
 * ones returned, and feed every verified `PaymentEvent` through `handleEvent()`.
 */

export type RecurringInterval = 'monthly' | 'yearly'

export type RecurringStatus = 'pending' | 'active' | 'past_due' | 'canceled'

export interface RecurringSubscription {
  /** The customer/tenant this subscription bills. One per billableId. */
  billableId: string
  plan: string
  /** Price per period, in the currency's major unit. */
  amount: number
  interval: RecurringInterval
  status: RecurringStatus
  /** Active until this instant (epoch ms). Undefined before the first payment. */
  paidThrough?: number
  /** The outstanding (unpaid) payment id awaiting confirmation, if any. */
  pendingPaymentId?: string
  /** Kept for gateways that need it each period (e.g. phone for Express push). */
  customer?: PaymentRequest['customer']
  createdAt: number
  updatedAt: number
}

export interface RecurringStore {
  save(sub: RecurringSubscription): Promise<void>
  get(billableId: string): Promise<RecurringSubscription | undefined>
  list(): Promise<RecurringSubscription[]>
}

/** In-memory `RecurringStore` — swap for a durable one in production. */
export class MemoryRecurringStore implements RecurringStore {
  private readonly subs = new Map<string, RecurringSubscription>()

  async save(sub: RecurringSubscription): Promise<void> {
    this.subs.set(sub.billableId, sub)
  }
  async get(billableId: string): Promise<RecurringSubscription | undefined> {
    return this.subs.get(billableId)
  }
  async list(): Promise<RecurringSubscription[]> {
    return [...this.subs.values()]
  }
}

/** Add one billing interval to an epoch-ms instant (calendar-aware). */
export function addInterval(ms: number, interval: RecurringInterval): number {
  const d = new Date(ms)
  if (interval === 'yearly') d.setFullYear(d.getFullYear() + 1)
  else d.setMonth(d.getMonth() + 1)
  return d.getTime()
}

export interface RecurringBillingOptions {
  /** Payment driver (ProxyPay / AppyPay / …). */
  gateway: PaymentGateway
  /** Ledger for payment records + webhook idempotency. Default: in-memory. */
  ledger?: PaymentLedger
  /** Where subscriptions live. Default: in-memory. */
  store?: RecurringStore
  /** Days before period end that a subscription becomes `due()`. Default 5. */
  leadDays?: number
  /** ISO 4217 currency passed to the gateway (defaults to the gateway's own). */
  currency?: string
}

export interface SubscribeInput {
  billableId: string
  plan: string
  amount: number
  interval: RecurringInterval
  customer?: PaymentRequest['customer']
  /** Extra fields passed to the gateway and echoed on the webhook. */
  metadata?: Record<string, string>
}

export interface HandleEventResult {
  /** false = the event was a duplicate (already applied) — nothing changed. */
  applied: boolean
  subscription?: RecurringSubscription
}

/**
 * Coordinates reference-per-period recurring billing over a `PaymentGateway`.
 * Stateful pieces are pluggable (`store`, `ledger`) so you can back them with a
 * database; the defaults are in-memory.
 */
export class RecurringReferenceBilling {
  private readonly gateway: PaymentGateway
  private readonly ledger: PaymentLedger
  private readonly store: RecurringStore
  private readonly leadMs: number
  private readonly currency: string | undefined

  constructor(options: RecurringBillingOptions) {
    this.gateway = options.gateway
    this.ledger = options.ledger ?? new PaymentLedger()
    this.store = options.store ?? new MemoryRecurringStore()
    this.leadMs = (options.leadDays ?? 5) * 86_400_000
    this.currency = options.currency
  }

  get(billableId: string): Promise<RecurringSubscription | undefined> {
    return this.store.get(billableId)
  }

  /** Start a subscription and issue the first period's reference. */
  async subscribe(
    input: SubscribeInput,
  ): Promise<{ subscription: RecurringSubscription; instruction: PaymentInstruction }> {
    const now = Date.now()
    const subscription: RecurringSubscription = {
      billableId: input.billableId,
      plan: input.plan,
      amount: input.amount,
      interval: input.interval,
      status: 'pending',
      ...(input.customer ? { customer: input.customer } : {}),
      createdAt: now,
      updatedAt: now,
    }
    const instruction = await this.issueFor(subscription, input.metadata)
    return { subscription, instruction }
  }

  /**
   * Issue the next period's reference for a subscription (call for the ones
   * `due()` returns, or to re-collect after a lapse). Replaces any outstanding
   * reference as the one now awaited.
   */
  async issueNext(billableId: string, metadata?: Record<string, string>): Promise<PaymentInstruction> {
    const sub = await this.store.get(billableId)
    if (!sub) throw new Error(`no recurring subscription for ${billableId}`)
    if (sub.status === 'canceled') throw new Error(`subscription ${billableId} is canceled`)
    return this.issueFor(sub, metadata)
  }

  private async issueFor(
    sub: RecurringSubscription,
    metadata?: Record<string, string>,
  ): Promise<PaymentInstruction> {
    const reference = `${sub.billableId}:${sub.plan}:${Date.now()}`
    const request: PaymentRequest = {
      billableId: sub.billableId,
      amount: sub.amount,
      reference,
      ...(this.currency ? { currency: this.currency } : {}),
      ...(sub.customer ? { customer: sub.customer } : {}),
      metadata: { recurring: '1', plan: sub.plan, interval: sub.interval, ...metadata },
    }
    const instruction = await this.gateway.createPayment(request)
    await this.ledger.created(instruction, request)
    sub.pendingPaymentId = instruction.id
    sub.updatedAt = Date.now()
    await this.store.save(sub)
    return instruction
  }

  /**
   * Feed a verified `PaymentEvent`. Applies it once (via the ledger's
   * idempotency): on success for the outstanding reference, extends
   * `paidThrough` by one interval and marks the subscription active; on failure,
   * marks it `past_due`.
   */
  async handleEvent(event: PaymentEvent): Promise<HandleEventResult> {
    let subscription: RecurringSubscription | undefined
    const { fresh } = await this.ledger.apply(event, async (record) => {
      const billableId = event.billableId ?? record?.billableId
      if (!billableId) return
      const sub = await this.store.get(billableId)
      if (!sub || event.paymentId !== sub.pendingPaymentId) return // not the awaited reference
      if (event.type === 'payment.succeeded') {
        const base = sub.paidThrough && sub.paidThrough > Date.now() ? sub.paidThrough : Date.now()
        sub.paidThrough = addInterval(base, sub.interval)
        sub.status = 'active'
        delete sub.pendingPaymentId
      } else {
        sub.status = 'past_due'
      }
      sub.updatedAt = Date.now()
      await this.store.save(sub)
      subscription = sub
    })
    return { applied: fresh, ...(subscription ? { subscription } : {}) }
  }

  /**
   * Subscriptions that need their next reference issued now: not canceled,
   * nothing outstanding, and within `leadDays` of the paid-through date (or
   * never paid). Run this on a schedule and call `issueNext()` for each.
   */
  async due(now: number = Date.now()): Promise<RecurringSubscription[]> {
    const subs = await this.store.list()
    return subs.filter(
      (s) =>
        s.status !== 'canceled' &&
        !s.pendingPaymentId &&
        (s.paidThrough == null || s.paidThrough - now <= this.leadMs),
    )
  }

  async cancel(billableId: string): Promise<void> {
    const sub = await this.store.get(billableId)
    if (!sub) return
    sub.status = 'canceled'
    delete sub.pendingPaymentId
    sub.updatedAt = Date.now()
    await this.store.save(sub)
  }
}
