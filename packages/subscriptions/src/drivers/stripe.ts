import { createHmac, timingSafeEqual } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type { BillingPeriod } from '../plans.js'
import {
  WebhookInvalidError,
  type BillingGateway,
  type CheckoutInput,
  type CreateSubscriptionInput,
  type PortalInput,
  type SwapInput,
  type WebhookEvent,
} from '../gateway.js'

export class StripeRequestError extends BasaltError {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super('BILLING_GATEWAY_ERROR', `Stripe request failed (${httpStatus}): ${message}`)
  }
}

/** Loosely-typed Stripe webhook envelope — we only touch a few fields. */
interface StripeEvent {
  id?: string
  type?: string
  data?: { object?: { metadata?: Record<string, string>; [key: string]: unknown } }
}

/** Stripe event type → Basalt domain webhook type. Others are ignored. */
const EVENT_MAP: Record<string, WebhookEvent['type']> = {
  'customer.subscription.deleted': 'subscription.canceled',
  'invoice.payment_failed': 'payment.failed',
  'invoice.paid': 'payment.succeeded',
  'invoice.payment_succeeded': 'payment.succeeded',
}

export interface StripeGatewayOptions {
  secretKey: string
  /** The endpoint signing secret (`whsec_...`) used to verify webhooks. */
  webhookSecret: string
  /** Resolves the Stripe Price ID for a plan + billing period. */
  priceId: (plan: string, period: BillingPeriod) => string
  /** Resolves (or ensures) the Stripe Customer ID for a billable entity. */
  customerId: (billableId: string) => string | Promise<string>
  /**
   * Extracts the billable id from a verified event. Default: reads
   * `data.object.metadata.billableId` — which createSubscription sets on the
   * subscription. Override for events whose object carries it elsewhere.
   */
  resolveBillableId?: (event: unknown) => string | undefined
  /** Webhook timestamp tolerance in seconds. Default: 300 (5 minutes). */
  tolerance?: number
  /** Injected fetch (tests). Default: global fetch. */
  fetch?: typeof fetch
  /** Clock in ms (tests). Default: Date.now. */
  now?: () => number
  /** API base, for tests/mocks. Default: https://api.stripe.com */
  apiBase?: string
}

/**
 * Stripe billing gateway targeting the Stripe REST API directly — no `stripe`
 * SDK dependency. HTTP goes through an injectable fetch; webhook signatures are
 * verified with node:crypto using Stripe's documented scheme.
 */
export class StripeBillingGateway implements BillingGateway {
  readonly name = 'stripe'
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly tolerance: number
  private readonly apiBase: string
  private readonly resolveBillableId: (event: unknown) => string | undefined

  constructor(private readonly options: StripeGatewayOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.tolerance = options.tolerance ?? 300
    this.apiBase = options.apiBase ?? 'https://api.stripe.com'
    this.resolveBillableId =
      options.resolveBillableId ??
      ((event) =>
        (event as StripeEvent | undefined)?.data?.object?.metadata?.['billableId'])
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<{ gatewayRef: string }> {
    const customer = await this.options.customerId(input.billableId)
    const price = this.options.priceId(input.plan, input.period)
    const created = await this.request('POST', '/v1/subscriptions', {
      customer,
      'items[0][price]': price,
      'metadata[billableId]': input.billableId,
      ...(input.trialDays !== undefined
        ? { trial_period_days: String(input.trialDays) }
        : {}),
    })
    return { gatewayRef: String((created as { id?: string }).id) }
  }

  async cancelSubscription(gatewayRef: string, options: { atPeriodEnd: boolean }): Promise<void> {
    if (options.atPeriodEnd) {
      await this.request('POST', `/v1/subscriptions/${gatewayRef}`, {
        cancel_at_period_end: 'true',
      })
    } else {
      await this.request('DELETE', `/v1/subscriptions/${gatewayRef}`)
    }
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string; id: string }> {
    const customer = await this.options.customerId(input.billableId)
    const created = await this.request('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer,
      'line_items[0][price]': this.options.priceId(input.plan, input.period),
      'line_items[0][quantity]': '1',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      'subscription_data[metadata][billableId]': input.billableId,
      ...(input.trialDays !== undefined
        ? { 'subscription_data[trial_period_days]': String(input.trialDays) }
        : {}),
    })
    return { url: String((created as { url?: string }).url), id: String((created as { id?: string }).id) }
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    const customer = await this.options.customerId(input.billableId)
    const created = await this.request('POST', '/v1/billing_portal/sessions', {
      customer,
      return_url: input.returnUrl,
    })
    return { url: String((created as { url?: string }).url) }
  }

  async swapSubscription(gatewayRef: string, input: SwapInput): Promise<void> {
    // Stripe updates a subscription by its item id, so fetch the current item first.
    const sub = (await this.request('GET', `/v1/subscriptions/${gatewayRef}`)) as {
      items?: { data?: Array<{ id?: string }> }
    }
    const itemId = sub.items?.data?.[0]?.id
    if (!itemId) throw new StripeRequestError(500, 'subscription has no line item to update')
    await this.request('POST', `/v1/subscriptions/${gatewayRef}`, {
      'items[0][id]': itemId,
      'items[0][price]': this.options.priceId(input.plan, input.period),
      proration_behavior: input.prorationBehavior ?? 'create_prorations',
    })
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent | null {
    if (!signature) throw new WebhookInvalidError()

    const parts = Object.fromEntries(
      signature.split(',').map((pair) => {
        const index = pair.indexOf('=')
        return [pair.slice(0, index), pair.slice(index + 1)]
      }),
    ) as { t?: string; v1?: string }
    const timestamp = Number(parts.t)
    if (!Number.isFinite(timestamp) || !parts.v1) throw new WebhookInvalidError()

    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex')
    const received = parts.v1
    const a = Buffer.from(expected)
    const b = Buffer.from(received)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookInvalidError()

    if (Math.abs(this.now() / 1000 - timestamp) > this.tolerance) throw new WebhookInvalidError()

    let event: StripeEvent
    try {
      event = JSON.parse(rawBody) as StripeEvent
    } catch {
      throw new WebhookInvalidError()
    }

    const type = event.type ? EVENT_MAP[event.type] : undefined
    if (!type || !event.id) return null
    const billableId = this.resolveBillableId(event)
    if (!billableId) return null
    // Invoice events carry the subscription id in `subscription`; subscription
    // events carry it in `id`. Either lets us learn a Checkout-created ref.
    const obj = event.data?.object as { subscription?: string; id?: string } | undefined
    const gatewayRef = obj?.subscription ?? obj?.id
    return { id: event.id, type, billableId, ...(gatewayRef ? { gatewayRef } : {}) }
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, string>,
  ): Promise<unknown> {
    const response = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      ...(body ? { body: formEncode(body) } : {}),
    })
    const text = await response.text()
    const json = text ? (JSON.parse(text) as unknown) : {}
    if (!response.ok) {
      const message =
        (json as { error?: { message?: string } }).error?.message ?? text ?? 'unknown error'
      throw new StripeRequestError(response.status, message)
    }
    return json
  }
}

function formEncode(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}
