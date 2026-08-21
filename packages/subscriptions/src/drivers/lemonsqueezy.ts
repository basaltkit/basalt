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

export class LemonSqueezyRequestError extends BasaltError {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super('BILLING_GATEWAY_ERROR', `Lemon Squeezy request failed (${httpStatus}): ${message}`)
  }
}

/** Loosely-typed Lemon Squeezy webhook envelope — we only touch a few fields. */
interface LemonEvent {
  meta?: { event_name?: string; custom_data?: Record<string, string> | null }
  data?: { id?: string; attributes?: { subscription_id?: string | number; [key: string]: unknown } }
}

/** Lemon Squeezy `meta.event_name` → Basalt domain webhook type. Others ignored. */
const EVENT_MAP: Record<string, WebhookEvent['type']> = {
  subscription_cancelled: 'subscription.canceled',
  subscription_expired: 'subscription.canceled',
  subscription_payment_success: 'payment.succeeded',
  subscription_payment_failed: 'payment.failed',
}

export interface LemonSqueezyGatewayOptions {
  /** Lemon Squeezy API key (Bearer). */
  apiKey: string
  /** Webhook signing secret used to verify `X-Signature`. */
  webhookSecret: string
  /** Lemon Squeezy Store ID (needed to create checkouts). */
  storeId: string
  /** Resolves the Lemon Squeezy Variant ID for a plan + billing period. */
  variantId: (plan: string, period: BillingPeriod) => string
  /** Resolves the Lemon Squeezy Customer ID for a billable — required for the portal. */
  customerId?: (billableId: string) => string | Promise<string>
  /**
   * Extracts the billable id from a verified event. Default: reads
   * `meta.custom_data.billableId` — which the checkout call sets.
   */
  resolveBillableId?: (event: unknown) => string | undefined
  /** Injected fetch (tests). Default: global fetch. */
  fetch?: typeof fetch
  /** API base, for tests/mocks. Default: https://api.lemonsqueezy.com/v1 */
  apiBase?: string
}

const JSON_API = 'application/vnd.api+json'

/**
 * Lemon Squeezy billing gateway targeting the REST API directly (JSON:API) — no
 * SDK. Lemon Squeezy is a merchant-of-record and checkout-first, so
 * `createSubscription`/`createCheckoutSession` create a **checkout**; the durable
 * subscription id arrives on a `subscription_*` webhook via `gatewayRef`. Webhook
 * signatures use the `X-Signature` scheme (HMAC-SHA256 hex over the raw body).
 */
export class LemonSqueezyBillingGateway implements BillingGateway {
  readonly name = 'lemonsqueezy'
  private readonly fetch: typeof fetch
  private readonly apiBase: string
  private readonly resolveBillableId: (event: unknown) => string | undefined

  constructor(private readonly options: LemonSqueezyGatewayOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.apiBase = options.apiBase ?? 'https://api.lemonsqueezy.com/v1'
    this.resolveBillableId =
      options.resolveBillableId ??
      ((event) => (event as LemonEvent | undefined)?.meta?.custom_data?.['billableId'])
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<{ gatewayRef: string }> {
    const checkout = await this.checkout(input.billableId, input.plan, input.period)
    return { gatewayRef: String(checkout.id) }
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string; id: string }> {
    const checkout = await this.checkout(input.billableId, input.plan, input.period, input.successUrl)
    return { url: String(checkout.attributes?.url), id: String(checkout.id) }
  }

  private async checkout(billableId: string, plan: string, period: BillingPeriod, redirectUrl?: string) {
    const created = (await this.request('POST', '/checkouts', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: { custom: { billableId } },
          ...(redirectUrl ? { product_options: { redirect_url: redirectUrl } } : {}),
        },
        relationships: {
          store: { data: { type: 'stores', id: this.options.storeId } },
          variant: { data: { type: 'variants', id: this.options.variantId(plan, period) } },
        },
      },
    })) as { id?: string; attributes?: { url?: string } }
    return created
  }

  async cancelSubscription(gatewayRef: string, _options: { atPeriodEnd: boolean }): Promise<void> {
    // Lemon Squeezy DELETE cancels the subscription; it stays active until the
    // end of the current billing period (there is no true immediate cancel).
    await this.request('DELETE', `/subscriptions/${gatewayRef}`)
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    if (!this.options.customerId) {
      throw new LemonSqueezyRequestError(500, 'customerId resolver is required for the customer portal')
    }
    const customer = await this.options.customerId(input.billableId)
    const found = (await this.request('GET', `/customers/${customer}`)) as {
      attributes?: { urls?: { customer_portal?: string } }
    }
    return { url: String(found.attributes?.urls?.customer_portal) }
  }

  async swapSubscription(gatewayRef: string, input: SwapInput): Promise<void> {
    const behavior = input.prorationBehavior ?? 'create_prorations'
    await this.request('PATCH', `/subscriptions/${gatewayRef}`, {
      data: {
        type: 'subscriptions',
        id: gatewayRef,
        attributes: {
          variant_id: this.options.variantId(input.plan, input.period),
          disable_prorations: behavior === 'none',
          ...(behavior === 'always_invoice' ? { invoice_immediately: true } : {}),
        },
      },
    })
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent | null {
    if (!signature) throw new WebhookInvalidError()

    const expected = createHmac('sha256', this.options.webhookSecret).update(rawBody).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookInvalidError()

    let event: LemonEvent
    try {
      event = JSON.parse(rawBody) as LemonEvent
    } catch {
      throw new WebhookInvalidError()
    }

    const name = event.meta?.event_name
    const type = name ? EVENT_MAP[name] : undefined
    if (!type) return null
    const billableId = this.resolveBillableId(event)
    if (!billableId) return null
    // Payment events carry the subscription id in attributes.subscription_id;
    // subscription events carry it in data.id.
    const rawRef = event.data?.attributes?.subscription_id ?? event.data?.id
    const gatewayRef = rawRef !== undefined ? String(rawRef) : undefined
    // Lemon Squeezy webhooks have no event id of their own — use the subscription
    // ref + event name as a stable idempotency key.
    const id = `${name}:${gatewayRef ?? billableId}`
    return { id, type, billableId, ...(gatewayRef ? { gatewayRef } : {}) }
  }

  private async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: JSON_API,
        ...(body !== undefined ? { 'content-type': JSON_API } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    const json = text ? (JSON.parse(text) as { data?: unknown; errors?: { detail?: string }[] }) : {}
    if (!response.ok) {
      throw new LemonSqueezyRequestError(response.status, json.errors?.[0]?.detail ?? text ?? 'unknown error')
    }
    return (json as { data?: unknown }).data ?? json
  }
}
