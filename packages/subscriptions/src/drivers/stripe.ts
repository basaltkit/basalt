import { createHmac, timingSafeEqual } from 'node:crypto'
import { MachizeError } from '@machize/core'
import type { BillingPeriod } from '../plans.js'
import {
  WebhookInvalidError,
  type BillingGateway,
  type CreateSubscriptionInput,
  type WebhookEvent,
} from '../gateway.js'

export class StripeRequestError extends MachizeError {
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

/** Stripe event type → Machize domain webhook type. Others are ignored. */
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
    return { id: event.id, type, billableId }
  }

  private async request(
    method: 'POST' | 'DELETE',
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
