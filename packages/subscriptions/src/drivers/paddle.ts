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

export class PaddleRequestError extends BasaltError {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super('BILLING_GATEWAY_ERROR', `Paddle request failed (${httpStatus}): ${message}`)
  }
}

/** Loosely-typed Paddle Billing webhook envelope — we only touch a few fields. */
interface PaddleEvent {
  event_id?: string
  event_type?: string
  data?: {
    id?: string
    subscription_id?: string
    custom_data?: Record<string, string> | null
    [key: string]: unknown
  }
}

/** Paddle Billing `event_type` → Basalt domain webhook type. Others are ignored. */
const EVENT_MAP: Record<string, WebhookEvent['type']> = {
  'subscription.canceled': 'subscription.canceled',
  'transaction.completed': 'payment.succeeded',
  'transaction.paid': 'payment.succeeded',
  'transaction.payment_failed': 'payment.failed',
}

/** SwapInput proration → Paddle's `proration_billing_mode`. */
const PRORATION: Record<NonNullable<SwapInput['prorationBehavior']>, string> = {
  create_prorations: 'prorated_immediately',
  none: 'do_not_bill',
  always_invoice: 'full_immediately',
}

export interface PaddleGatewayOptions {
  /** Paddle API key (Bearer). */
  apiKey: string
  /** Notification signing secret (`pdl_ntfset_…` / `ntfset_…`) used to verify webhooks. */
  webhookSecret: string
  /** Resolves the Paddle Price ID (`pri_…`) for a plan + billing period. */
  priceId: (plan: string, period: BillingPeriod) => string
  /** Resolves (or ensures) the Paddle Customer ID (`ctm_…`) for a billable entity. */
  customerId: (billableId: string) => string | Promise<string>
  /**
   * Extracts the billable id from a verified event. Default: reads
   * `data.custom_data.billableId` — which the create/checkout calls set.
   */
  resolveBillableId?: (event: unknown) => string | undefined
  /** Webhook timestamp tolerance in seconds. Default: 300 (5 minutes). */
  tolerance?: number
  /** Injected fetch (tests). Default: global fetch. */
  fetch?: typeof fetch
  /** Clock in ms (tests). Default: Date.now. */
  now?: () => number
  /** API base, for tests/mocks. Default: https://api.paddle.com */
  apiBase?: string
}

/**
 * Paddle **Billing** gateway targeting the Paddle REST API directly — no SDK.
 * HTTP goes through an injectable fetch; webhook signatures are verified with
 * node:crypto using Paddle's `Paddle-Signature` scheme (`ts=…;h1=…`).
 *
 * Paddle is checkout-first: `createSubscription` and `createCheckoutSession`
 * both create a **transaction** (the subscription materializes once the customer
 * pays, and its id arrives on a `subscription.*` webhook via `gatewayRef`).
 */
export class PaddleBillingGateway implements BillingGateway {
  readonly name = 'paddle'
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly tolerance: number
  private readonly apiBase: string
  private readonly resolveBillableId: (event: unknown) => string | undefined

  constructor(private readonly options: PaddleGatewayOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.tolerance = options.tolerance ?? 300
    this.apiBase = options.apiBase ?? 'https://api.paddle.com'
    this.resolveBillableId =
      options.resolveBillableId ??
      ((event) => (event as PaddleEvent | undefined)?.data?.custom_data?.['billableId'])
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<{ gatewayRef: string }> {
    const customer = await this.options.customerId(input.billableId)
    const created = await this.request('POST', '/transactions', {
      items: [{ price_id: this.options.priceId(input.plan, input.period), quantity: 1 }],
      customer_id: customer,
      collection_mode: 'automatic',
      custom_data: { billableId: input.billableId },
    })
    return { gatewayRef: String((created as { id?: string }).id) }
  }

  async cancelSubscription(gatewayRef: string, options: { atPeriodEnd: boolean }): Promise<void> {
    await this.request('POST', `/subscriptions/${gatewayRef}/cancel`, {
      effective_from: options.atPeriodEnd ? 'next_billing_period' : 'immediately',
    })
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string; id: string }> {
    const customer = await this.options.customerId(input.billableId)
    const created = (await this.request('POST', '/transactions', {
      items: [{ price_id: this.options.priceId(input.plan, input.period), quantity: 1 }],
      customer_id: customer,
      collection_mode: 'automatic',
      custom_data: { billableId: input.billableId },
      checkout: { url: input.successUrl },
    })) as { id?: string; checkout?: { url?: string } }
    return { url: String(created.checkout?.url), id: String(created.id) }
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    const customer = await this.options.customerId(input.billableId)
    const created = (await this.request(
      'POST',
      `/customers/${customer}/portal-sessions`,
      {},
    )) as { urls?: { general?: { overview?: string } } }
    return { url: String(created.urls?.general?.overview) }
  }

  async swapSubscription(gatewayRef: string, input: SwapInput): Promise<void> {
    await this.request('PATCH', `/subscriptions/${gatewayRef}`, {
      items: [{ price_id: this.options.priceId(input.plan, input.period), quantity: 1 }],
      proration_billing_mode: PRORATION[input.prorationBehavior ?? 'create_prorations'],
    })
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent | null {
    if (!signature) throw new WebhookInvalidError()

    // Paddle-Signature: `ts=1700000000;h1=<hex hmac>`
    const parts = Object.fromEntries(
      signature.split(';').map((pair) => {
        const index = pair.indexOf('=')
        return [pair.slice(0, index).trim(), pair.slice(index + 1)]
      }),
    ) as { ts?: string; h1?: string }
    const timestamp = Number(parts.ts)
    if (!Number.isFinite(timestamp) || !parts.h1) throw new WebhookInvalidError()

    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`${parts.ts}:${rawBody}`)
      .digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(parts.h1)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookInvalidError()

    if (Math.abs(this.now() / 1000 - timestamp) > this.tolerance) throw new WebhookInvalidError()

    let event: PaddleEvent
    try {
      event = JSON.parse(rawBody) as PaddleEvent
    } catch {
      throw new WebhookInvalidError()
    }

    const type = event.event_type ? EVENT_MAP[event.event_type] : undefined
    if (!type || !event.event_id) return null
    const billableId = this.resolveBillableId(event)
    if (!billableId) return null
    // Transaction events carry the subscription id in `subscription_id`;
    // subscription events carry it in `id`.
    const gatewayRef = event.data?.subscription_id ?? event.data?.id
    return { id: event.event_id, type, billableId, ...(gatewayRef ? { gatewayRef } : {}) }
  }

  private async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    const json = text ? (JSON.parse(text) as { data?: unknown; error?: { detail?: string } }) : {}
    if (!response.ok) {
      throw new PaddleRequestError(response.status, json.error?.detail ?? text ?? 'unknown error')
    }
    // Paddle wraps successful responses in `{ data: … }`.
    return (json as { data?: unknown }).data ?? json
  }
}
