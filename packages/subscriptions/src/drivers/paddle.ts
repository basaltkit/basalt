import { createHmac, timingSafeEqual } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type { BillingPeriod } from '../plans.js'
import {
  attestedPlanForPrice,
  CheckoutRequiredError,
  requireWebhookSecret,
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
 * Paddle is checkout-first: `createCheckoutSession` creates a **transaction**
 * (the subscription materializes once the customer pays, and its id arrives on
 * the webhooks via `gatewayRef`). There is no server-side "create a paid
 * subscription", so `createSubscription` throws {@link CheckoutRequiredError} —
 * use `Subscriptions.checkout()`.
 */
export class PaddleBillingGateway implements BillingGateway {
  readonly name = 'paddle'
  readonly signatureHeader = 'paddle-signature'
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

  /**
   * Always throws {@link CheckoutRequiredError}. Creating a transaction here and
   * returning its `txn_…` id as the subscription ref activated the plan before
   * anything was paid, and left a ref that `cancel`/`swap` could not address
   * (`/subscriptions/txn_…` does not exist).
   */
  async createSubscription(_input: CreateSubscriptionInput): Promise<{ gatewayRef: string }> {
    throw new CheckoutRequiredError('Paddle')
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
      custom_data: { billableId: input.billableId, plan: input.plan, period: input.period },
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

  async resumeSubscription(gatewayRef: string): Promise<void> {
    // Removing the scheduled change withdraws a `next_billing_period` cancel.
    await this.request('PATCH', `/subscriptions/${gatewayRef}`, { scheduled_change: null })
  }

  async swapSubscription(gatewayRef: string, input: SwapInput): Promise<void> {
    await this.request('PATCH', `/subscriptions/${gatewayRef}`, {
      items: [{ price_id: this.options.priceId(input.plan, input.period), quantity: 1 }],
      proration_billing_mode: PRORATION[input.prorationBehavior ?? 'create_prorations'],
    })
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent | null {
    // Fail closed before anything else: an empty/missing secret would make the
    // HMAC forgeable by anyone.
    const secret = requireWebhookSecret('PaddleBillingGateway', this.options.webhookSecret)
    if (!signature) throw new WebhookInvalidError()

    // Paddle-Signature: `ts=1700000000;h1=<hex hmac>[;h1=…]` — during a secret
    // rotation Paddle sends one `h1` per active secret; any of them may match.
    let ts: string | undefined
    const candidates: string[] = []
    for (const pair of signature.split(';')) {
      const index = pair.indexOf('=')
      if (index < 0) continue
      const key = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (key === 'ts') ts = value
      else if (key === 'h1' && value !== '') candidates.push(value)
    }
    const timestamp = Number(ts)
    if (ts === undefined || ts === '' || !Number.isFinite(timestamp) || candidates.length === 0) {
      throw new WebhookInvalidError()
    }

    const expected = Buffer.from(createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex'))
    const matches = candidates.some((candidate) => {
      const received = Buffer.from(candidate)
      return received.length === expected.length && timingSafeEqual(received, expected)
    })
    if (!matches) throw new WebhookInvalidError()

    if (Math.abs(this.now() / 1000 - timestamp) > this.tolerance) throw new WebhookInvalidError()

    let event: PaddleEvent
    try {
      event = JSON.parse(rawBody) as PaddleEvent
    } catch {
      throw new WebhookInvalidError()
    }

    const type =
      event.event_type && Object.hasOwn(EVENT_MAP, event.event_type) ? EVENT_MAP[event.event_type] : undefined
    if (!type || !event.event_id) return null
    const billableId = this.resolveBillableId(event)
    if (!billableId) return null
    // Transaction events carry the subscription id in `subscription_id`;
    // subscription events carry it in `id`.
    const gatewayRef = event.data?.subscription_id ?? event.data?.id
    // The plan/period we stamped next to the charged price (signed payload).
    // Bound to the price this event actually charges: custom_data is stamped
    // at checkout and goes stale when the subscription's price changes later.
    const { plan, period } = attestedPlanForPrice(
      event.data?.custom_data,
      paddleChargedPrices(event.data?.['items']),
      this.options.priceId,
    )
    return {
      id: event.event_id,
      type,
      billableId,
      ...(gatewayRef ? { gatewayRef } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(period !== undefined ? { period } : {}),
    }
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

/** Price ids on a Paddle transaction/subscription's `items` (`price.id` or `price_id`). */
function paddleChargedPrices(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  const prices: string[] = []
  for (const raw of items as unknown[]) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as { price?: { id?: unknown } | null; price_id?: unknown }
    for (const value of [item.price?.id, item.price_id]) {
      if (typeof value === 'string' && value !== '') prices.push(value)
    }
  }
  return prices
}
